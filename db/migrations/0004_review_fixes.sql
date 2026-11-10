-- Fixes from the 9 November 2026 review. Finding IDs are in docs/DECISIONS.md.

-- Outbox (ARCH-02, BUG-02, BUG-03) ---------------------------------------------------------------
-- Messages and file deletions are written in the same transaction as the change that causes them,
-- then delivered after commit with retries. A rolled-back change sends nothing and deletes nothing.
-- The payload is encrypted because it can hold a sign-in link or a phone number, and it is cleared
-- once the item is finished, so nothing sensitive stays here.
CREATE TABLE outbox (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('mail','delete_object')),
  topic            text NOT NULL,
  payload_enc      text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  last_error       text,
  created_at       timestamptz NOT NULL,
  done_at          timestamptz
);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at) WHERE status = 'pending';

-- Every role may add work; none may read or change it directly.
GRANT INSERT ON outbox TO vittora_app, vittora_auth, vittora_ops;

-- Claims due items for one delivery attempt. The lease means a crashed worker's items come back later.
CREATE FUNCTION outbox_claim(p_ids uuid[], p_limit int, p_now timestamptz, p_lease_seconds int)
RETURNS TABLE (id uuid, kind text, topic text, payload_enc text, attempts int)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox o SET next_attempt_at = p_now + make_interval(secs => p_lease_seconds)
  WHERE o.id IN (
    SELECT x.id FROM outbox x
    WHERE x.status = 'pending' AND x.next_attempt_at <= p_now AND (p_ids IS NULL OR x.id = ANY(p_ids))
    ORDER BY x.next_attempt_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING o.id, o.kind, o.topic, o.payload_enc, o.attempts;
$$;

-- Records the outcome. Retries back off from 30 seconds; after the last attempt the item is failed.
CREATE FUNCTION outbox_finish(p_id uuid, p_ok boolean, p_error text, p_now timestamptz, p_max_attempts int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempts int;
  v_status text;
BEGIN
  SELECT attempts + 1 INTO v_attempts FROM outbox WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_status := CASE WHEN p_ok THEN 'sent' WHEN v_attempts >= p_max_attempts THEN 'failed' ELSE 'pending' END;
  UPDATE outbox SET
    attempts = v_attempts,
    status = v_status,
    last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 80) END,
    next_attempt_at = CASE WHEN v_status = 'pending' THEN p_now + make_interval(secs => 30 * power(2, v_attempts - 1)) ELSE next_attempt_at END,
    done_at = CASE WHEN v_status = 'pending' THEN NULL ELSE p_now END,
    payload_enc = CASE WHEN v_status = 'pending' THEN payload_enc ELSE NULL END
  WHERE id = p_id;
  RETURN v_status;
END $$;

-- Ops can see what failed, by topic and error code only.
CREATE FUNCTION outbox_failures(p_since timestamptz)
RETURNS TABLE (id uuid, topic text, attempts int, last_error text, created_at timestamptz, done_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, topic, attempts, last_error, created_at, done_at FROM outbox
  WHERE status = 'failed' AND done_at >= p_since ORDER BY done_at DESC LIMIT 200;
$$;

REVOKE ALL ON FUNCTION outbox_claim(uuid[], int, timestamptz, int), outbox_finish(uuid, boolean, text, timestamptz, int),
  outbox_failures(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim(uuid[], int, timestamptz, int), outbox_finish(uuid, boolean, text, timestamptz, int),
  outbox_failures(timestamptz) TO vittora_ops;

-- Stored files that no row points to, for the orphan sweep (BUG-02). Returns the keys that are known.
CREATE FUNCTION object_keys_in_use(p_keys text[])
RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT object_key FROM case_document WHERE object_key = ANY(p_keys)
  UNION SELECT object_key FROM kyc_document WHERE object_key = ANY(p_keys);
$$;
REVOKE ALL ON FUNCTION object_keys_in_use(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION object_keys_in_use(text[]) TO vittora_ops;

-- Customer consent (SEC-01) ------------------------------------------------------------------------
-- The link and the one-time code both go to the customer's phone only. Consent covers the phone,
-- email and PAN it was given for; changing any of them needs a fresh consent.
ALTER TABLE customer_consent
  ADD COLUMN email_hash     text,
  ADD COLUMN recipient_enc  text,
  ADD COLUMN otp_hash       text,
  ADD COLUMN otp_expires_at timestamptz,
  ADD COLUMN otp_attempts   int NOT NULL DEFAULT 0,
  ADD COLUMN otp_sends      int NOT NULL DEFAULT 0;

-- Case lifecycle guard (ARCH-01) -------------------------------------------------------------------
-- The database refuses any status change that isn't an allowed move, so a bug in application code
-- can't skip a stage. The table mirrors nextStatuses() in cases/domain/lifecycle.ts; a test checks
-- that the two agree. Every status change must also bump the version.
CREATE TABLE case_transition (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO case_transition (from_status, to_status) VALUES
  ('REGISTERED','IN_REVIEW'), ('IN_REVIEW','APPROVED'), ('APPROVED','CUSTOMER_APPROVED'),
  ('CUSTOMER_APPROVED','DISBURSAL_IN_PROGRESS'), ('DISBURSAL_IN_PROGRESS','DISBURSED'), ('DISBURSED','REVERSED'),
  ('REGISTERED','RELOOK'), ('IN_REVIEW','RELOOK'), ('APPROVED','RELOOK'), ('CUSTOMER_APPROVED','RELOOK'), ('DISBURSAL_IN_PROGRESS','RELOOK'),
  ('RELOOK','REGISTERED'), ('RELOOK','IN_REVIEW'), ('RELOOK','APPROVED'), ('RELOOK','CUSTOMER_APPROVED'), ('RELOOK','DISBURSAL_IN_PROGRESS'),
  ('REGISTERED','REJECTED'), ('IN_REVIEW','REJECTED'), ('APPROVED','REJECTED'), ('CUSTOMER_APPROVED','REJECTED'),
  ('DISBURSAL_IN_PROGRESS','REJECTED'), ('RELOOK','REJECTED'),
  ('REGISTERED','WITHDRAWN'), ('IN_REVIEW','WITHDRAWN'), ('APPROVED','WITHDRAWN'), ('CUSTOMER_APPROVED','WITHDRAWN'),
  ('DISBURSAL_IN_PROGRESS','WITHDRAWN'), ('RELOOK','WITHDRAWN');
GRANT SELECT ON case_transition TO vittora_app, vittora_ops;

CREATE FUNCTION loan_case_guard_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM case_transition WHERE from_status = OLD.status AND to_status = NEW.status) THEN
      RAISE EXCEPTION 'case % can not move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <= OLD.version THEN
      RAISE EXCEPTION 'a status change must bump the version' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'RELOOK' AND NEW.relook_from IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'relook_from must be the status the case left' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'RELOOK' AND NEW.status NOT IN ('REJECTED','WITHDRAWN') AND NEW.status IS DISTINCT FROM OLD.relook_from THEN
      RAISE EXCEPTION 'a case leaving Relook returns to where it was' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loan_case_guard_status BEFORE UPDATE OF status ON loan_case
  FOR EACH ROW EXECUTE FUNCTION loan_case_guard_status();

-- Identifying product details are encrypted (SEC-03) ------------------------------------------------
-- Registration, chassis and engine numbers (and later business and student details) move out of the
-- plain JSON column into an encrypted copy. Duplicate checks keep using collateral_key_hash.
ALTER TABLE loan_case ADD COLUMN product_details_enc text;

-- One idempotency layer for every signed-in POST (STD-08) -------------------------------------------
-- A repeated request with the same Idempotency-Key gets the first response back instead of acting
-- twice. Keys are scoped to the signed-in user and the route. Responses are encrypted (they can hold
-- personal data) and kept for 24 hours.
CREATE TABLE idempotency_record (
  user_id       uuid NOT NULL,
  scope         text NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  state         text NOT NULL CHECK (state IN ('running','done')),
  status_code   int,
  response_enc  text,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, scope, key)
);
CREATE INDEX idempotency_record_age_idx ON idempotency_record (created_at);

-- Claims a key. Returns the earlier record when there is one; otherwise records this request as running.
CREATE FUNCTION idempotency_begin(p_user uuid, p_scope text, p_key text, p_hash text, p_now timestamptz)
RETURNS TABLE (is_new boolean, request_hash text, state text, status_code int, response_enc text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM idempotency_record WHERE created_at < p_now - interval '24 hours';
  INSERT INTO idempotency_record (user_id, scope, key, request_hash, state, created_at)
  VALUES (p_user, p_scope, p_key, p_hash, 'running', p_now)
  ON CONFLICT DO NOTHING;
  IF FOUND THEN
    RETURN QUERY SELECT true, p_hash, 'running'::text, NULL::int, NULL::text;
  ELSE
    RETURN QUERY SELECT false, r.request_hash, r.state, r.status_code, r.response_enc FROM idempotency_record r
      WHERE r.user_id = p_user AND r.scope = p_scope AND r.key = p_key;
  END IF;
END $$;

CREATE FUNCTION idempotency_finish(p_user uuid, p_scope text, p_key text, p_status int, p_response text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE idempotency_record SET state = 'done', status_code = p_status, response_enc = p_response
  WHERE user_id = p_user AND scope = p_scope AND key = p_key;
$$;

-- A failed request releases its key so the caller can try again.
CREATE FUNCTION idempotency_release(p_user uuid, p_scope text, p_key text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM idempotency_record WHERE user_id = p_user AND scope = p_scope AND key = p_key AND state = 'running';
$$;

REVOKE ALL ON FUNCTION idempotency_begin(uuid, text, text, text, timestamptz), idempotency_finish(uuid, text, text, int, text),
  idempotency_release(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION idempotency_begin(uuid, text, text, text, timestamptz), idempotency_finish(uuid, text, text, int, text),
  idempotency_release(uuid, text, text) TO vittora_app, vittora_ops;

-- Lenders mapped to loan types (GAP-02) -------------------------------------------------------------
-- NULL means the lender takes every loan type of that product.
ALTER TABLE lender_product ADD COLUMN loan_types text[];

-- One definition per product (ARCH-03) --------------------------------------------------------------
-- Names and schema versions now come from the product definitions in packages/product-schemas.
-- These columns are no longer read; the table records only which products are switched on.
COMMENT ON COLUMN product.name IS 'Not read by the app since 0004; names come from the product catalogue.';
COMMENT ON COLUMN product.schema_version IS 'Not read by the app since 0004; versions come from the product definitions.';
