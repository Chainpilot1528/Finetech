-- Parts 4, 5 and 6: case tracking, notifications, commissions, team management and settings.
-- vittora_ops still has no access to customer names, phones, PAN or address.

-- Part 4: case tracking ---------------------------------------------------------------------------

ALTER TABLE applicant ADD COLUMN phone_last4 text CHECK (phone_last4 ~ '^[0-9]{4}$');
CREATE INDEX applicant_phone_last4_idx ON applicant (partner_id, phone_last4);

ALTER TABLE loan_case
  ADD COLUMN owner_user_id uuid REFERENCES app_user(id),
  ADD COLUMN lender_id uuid REFERENCES lender(id),
  ADD COLUMN sanctioned_amount_paise bigint CHECK (sanctioned_amount_paise > 0),
  ADD COLUMN sanctioned_roi_bps integer CHECK (sanctioned_roi_bps > 0),
  ADD COLUMN sanctioned_tenure_months integer CHECK (sanctioned_tenure_months > 0),
  ADD COLUMN relook_from text,
  ADD COLUMN status_changed_at timestamptz;
UPDATE loan_case SET owner_user_id = created_by_user_id, status_changed_at = updated_at;
ALTER TABLE loan_case ALTER COLUMN owner_user_id SET NOT NULL, ALTER COLUMN status_changed_at SET NOT NULL;
CREATE INDEX loan_case_scope_idx ON loan_case (partner_id, owner_user_id, created_at DESC);
CREATE INDEX loan_case_queue_idx ON loan_case (status, status_changed_at);

CREATE TABLE case_note (
  id              uuid PRIMARY KEY,
  partner_id      uuid NOT NULL REFERENCES partner(id),
  case_id         uuid NOT NULL REFERENCES loan_case(id),
  author_id       uuid NOT NULL REFERENCES app_user(id),
  idempotency_key text NOT NULL,
  body_enc        text NOT NULL,
  at              timestamptz NOT NULL,
  UNIQUE (case_id, author_id, idempotency_key)
);

CREATE TABLE disbursal (
  id           uuid PRIMARY KEY,
  partner_id   uuid NOT NULL REFERENCES partner(id),
  case_id      uuid NOT NULL REFERENCES loan_case(id),
  tranche_no   integer NOT NULL CHECK (tranche_no > 0),
  utr          text NOT NULL UNIQUE,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  disbursed_on date NOT NULL,
  is_final     boolean NOT NULL,
  recorded_by  uuid NOT NULL REFERENCES app_user(id),
  at           timestamptz NOT NULL,
  UNIQUE (case_id, tranche_no)
);
CREATE INDEX disbursal_month_idx ON disbursal (partner_id, disbursed_on);

-- A reversal moves money back, so one person asks and a different person approves.
CREATE TABLE case_reversal (
  id           uuid PRIMARY KEY,
  partner_id   uuid NOT NULL REFERENCES partner(id),
  case_id      uuid NOT NULL REFERENCES loan_case(id),
  reason_code  text NOT NULL,
  reference    text NOT NULL,
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL REFERENCES app_user(id),
  decided_by   uuid REFERENCES app_user(id),
  requested_at timestamptz NOT NULL,
  decided_at   timestamptz,
  CONSTRAINT reversal_two_people CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX case_reversal_open_idx ON case_reversal (case_id) WHERE status = 'pending';

CREATE TABLE notification (
  id         uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partner(id),
  user_id    uuid NOT NULL REFERENCES app_user(id),
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX notification_user_idx ON notification (user_id, created_at DESC);

CREATE TABLE notification_pref (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id),
  partner_id uuid NOT NULL REFERENCES partner(id),
  prefs      jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE pii_reveal_log (
  id           uuid PRIMARY KEY,
  partner_id   uuid NOT NULL REFERENCES partner(id),
  actor_id     uuid NOT NULL REFERENCES app_user(id),
  applicant_id uuid NOT NULL REFERENCES applicant(id),
  field        text NOT NULL CHECK (field IN ('phone','email')),
  reason       text NOT NULL,
  at           timestamptz NOT NULL
);

-- Part 5: commissions -----------------------------------------------------------------------------

CREATE TABLE tax_rate (
  code       text NOT NULL CHECK (code IN ('gst','tds')),
  bps        integer NOT NULL CHECK (bps >= 0 AND bps <= 10000),
  valid_from date NOT NULL,
  PRIMARY KEY (code, valid_from)
);
INSERT INTO tax_rate (code, bps, valid_from) VALUES ('gst', 1800, '2017-07-01'), ('tds', 200, '2024-10-01');

CREATE TABLE rate_card (
  id              uuid PRIMARY KEY,
  lender_id       uuid NOT NULL REFERENCES lender(id),
  product         text NOT NULL REFERENCES product(code),
  loan_type       text,
  slab_min_paise  bigint NOT NULL DEFAULT 0 CHECK (slab_min_paise >= 0),
  slab_max_paise  bigint,
  pct_bps         integer NOT NULL CHECK (pct_bps > 0 AND pct_bps <= 10000),
  clawback_months integer NOT NULL DEFAULT 0 CHECK (clawback_months >= 0),
  valid_from      date NOT NULL,
  valid_to        date,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected')),
  created_by      uuid NOT NULL REFERENCES app_user(id),
  approved_by     uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL,
  decided_at      timestamptz,
  CONSTRAINT rate_card_two_people CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT rate_card_slab CHECK (slab_max_paise IS NULL OR slab_max_paise >= slab_min_paise),
  CONSTRAINT rate_card_dates CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX rate_card_lookup_idx ON rate_card (lender_id, product, status);

CREATE TABLE invoice (
  id                       uuid PRIMARY KEY,
  invoice_no               text,
  partner_id               uuid NOT NULL REFERENCES partner(id),
  case_id                  uuid NOT NULL REFERENCES loan_case(id),
  disbursal_id             uuid NOT NULL UNIQUE REFERENCES disbursal(id),
  status                   text NOT NULL CHECK (status IN
                             ('PENDING_RATE_CARD','DRAFT','RAISED','APPROVED','PAID','DISPUTED','VOID')),
  disbursal_paise          bigint NOT NULL,
  gross_paise              bigint NOT NULL DEFAULT 0,
  gst_paise                bigint NOT NULL DEFAULT 0,
  tds_paise                bigint NOT NULL DEFAULT 0,
  net_paise                bigint NOT NULL DEFAULT 0,
  recovered_paise          bigint NOT NULL DEFAULT 0,
  rate_card_snapshot       jsonb,
  billing_snapshot         jsonb,
  raised_at                timestamptz,
  approved_at              timestamptz,
  paid_at                  timestamptz,
  payout_ref               text,
  payout_requested_by      uuid REFERENCES app_user(id),
  payout_confirmed_by      uuid REFERENCES app_user(id),
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  version                  integer NOT NULL DEFAULT 1,
  UNIQUE (partner_id, invoice_no),
  CONSTRAINT payout_two_people CHECK (payout_confirmed_by IS NULL OR payout_confirmed_by <> payout_requested_by)
);
CREATE INDEX invoice_status_idx ON invoice (partner_id, status, created_at DESC);

-- Once an invoice has a number, the number and the money on it can't change, whoever is asking.
CREATE FUNCTION invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.invoice_no IS NOT NULL AND (
    NEW.invoice_no IS DISTINCT FROM OLD.invoice_no OR NEW.gross_paise <> OLD.gross_paise
    OR NEW.gst_paise <> OLD.gst_paise OR NEW.tds_paise <> OLD.tds_paise OR NEW.net_paise <> OLD.net_paise
  ) THEN
    RAISE EXCEPTION 'A raised invoice cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_guard BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION invoice_guard();

CREATE TABLE invoice_event (
  id          uuid PRIMARY KEY,
  partner_id  uuid NOT NULL REFERENCES partner(id),
  invoice_id  uuid NOT NULL REFERENCES invoice(id),
  from_status text,
  to_status   text NOT NULL,
  actor_id    uuid REFERENCES app_user(id),
  note        text,
  at          timestamptz NOT NULL
);
CREATE INDEX invoice_event_idx ON invoice_event (invoice_id, at);

-- Taking the next number in the same transaction as the raise is what keeps the sequence gap-free.
CREATE TABLE invoice_counter (
  partner_id uuid NOT NULL REFERENCES partner(id),
  fy         text NOT NULL,
  last_no    integer NOT NULL,
  PRIMARY KEY (partner_id, fy)
);

CREATE TABLE clawback (
  id             uuid PRIMARY KEY,
  partner_id     uuid NOT NULL REFERENCES partner(id),
  invoice_id     uuid NOT NULL UNIQUE REFERENCES invoice(id),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  recovered_paise bigint NOT NULL DEFAULT 0,
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','recovered')),
  raised_by      uuid NOT NULL REFERENCES app_user(id),
  approved_by    uuid REFERENCES app_user(id),
  at             timestamptz NOT NULL,
  decided_at     timestamptz,
  CONSTRAINT clawback_two_people CHECK (approved_by IS NULL OR approved_by <> raised_by),
  CONSTRAINT clawback_within_amount CHECK (recovered_paise <= amount_paise)
);

CREATE TABLE clawback_recovery (
  id           uuid PRIMARY KEY,
  partner_id   uuid NOT NULL REFERENCES partner(id),
  clawback_id  uuid NOT NULL REFERENCES clawback(id),
  invoice_id   uuid NOT NULL REFERENCES invoice(id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  at           timestamptz NOT NULL
);

-- Part 6: settings and team -----------------------------------------------------------------------

ALTER TABLE partner ADD COLUMN mask_customer_contact boolean NOT NULL DEFAULT true;

CREATE TABLE partner_billing (
  partner_id          uuid PRIMARY KEY REFERENCES partner(id),
  gst_registered      boolean NOT NULL,
  gstin               text,
  pan_enc             text NOT NULL,
  pan_last4           text NOT NULL,
  sac_code            text NOT NULL DEFAULT '998399',
  bank_acct_enc       text NOT NULL,
  bank_acct_last4     text NOT NULL,
  ifsc                text NOT NULL,
  bank_name           text NOT NULL,
  branch              text NOT NULL,
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')),
  reviewer_note       text,
  verified_at         timestamptz,
  verified_by         uuid REFERENCES app_user(id),
  updated_at          timestamptz NOT NULL,
  CONSTRAINT gstin_when_registered CHECK (NOT gst_registered OR gstin IS NOT NULL)
);

-- A partner's own edit always goes back to pending, so changed bank details can't stay verified.
CREATE FUNCTION partner_billing_reverify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'vittora_app' THEN
    NEW.verification_status := 'pending';
    NEW.reviewer_note := NULL;
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_billing_reverify BEFORE INSERT OR UPDATE ON partner_billing
  FOR EACH ROW EXECUTE FUNCTION partner_billing_reverify();

-- Team management needs two things vittora_app can't touch directly. Both only work inside its own tenant.
CREATE FUNCTION partner_user_sign_out(p_user uuid, p_now timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE session SET revoked_at = p_now
  WHERE user_id = p_user AND partner_id = current_partner_id() AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION partner_user_setup_token(p_id uuid, p_user uuid, p_hash text, p_expires timestamptz, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = p_user AND partner_id = current_partner_id() AND status = 'invited') THEN
    RETURN false;
  END IF;
  UPDATE auth_token SET used_at = p_now WHERE user_id = p_user AND purpose = 'password_setup' AND used_at IS NULL;
  INSERT INTO auth_token (id, user_id, purpose, token_hash, expires_at, created_at)
  VALUES (p_id, p_user, 'password_setup', p_hash, p_expires, p_now);
  RETURN true;
END $$;

-- Row-Level Security and grants -------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['case_note','disbursal','case_reversal','notification','notification_pref','pii_reveal_log',
                           'invoice','invoice_event','invoice_counter','clawback','clawback_recovery','partner_billing'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_all ON %I FOR ALL TO vittora_app
                    USING (partner_id = current_partner_id()) WITH CHECK (partner_id = current_partner_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['loan_case','case_status_history','case_document','case_note','disbursal','case_reversal',
                           'notification','notification_pref','invoice','invoice_event','clawback','clawback_recovery',
                           'partner_billing','applicant','customer_consent'] LOOP
    EXECUTE format('CREATE POLICY ops_all ON %I FOR ALL TO vittora_ops USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

CREATE POLICY tenant_partner_update ON partner FOR UPDATE TO vittora_app
  USING (id = current_partner_id()) WITH CHECK (id = current_partner_id());
GRANT UPDATE (city, pincode, employee_band, business_email, business_phone, mask_customer_contact) ON partner TO vittora_app;

GRANT INSERT (id, partner_id, name, email, phone, role, status, created_by) ON app_user TO vittora_app;
GRANT UPDATE (name, phone, role, status) ON app_user TO vittora_app;
GRANT EXECUTE ON FUNCTION partner_user_sign_out(uuid, timestamptz),
  partner_user_setup_token(uuid, uuid, text, timestamptz, timestamptz) TO vittora_app;

GRANT UPDATE (status, relook_from, status_changed_at, owner_user_id, updated_at, version) ON loan_case TO vittora_app;
GRANT SELECT, INSERT ON case_note, pii_reveal_log TO vittora_app;
GRANT SELECT ON disbursal, case_reversal, clawback, clawback_recovery TO vittora_app;
GRANT SELECT, INSERT, UPDATE ON notification, notification_pref, partner_billing, invoice_counter TO vittora_app;
GRANT SELECT ON invoice, tax_rate TO vittora_app;
GRANT UPDATE (status, invoice_no, gst_paise, net_paise, billing_snapshot, raised_at, updated_at, version) ON invoice TO vittora_app;
GRANT SELECT, INSERT ON invoice_event TO vittora_app;

GRANT SELECT ON loan_case, case_status_history, case_document, case_note, disbursal, case_reversal, notification_pref,
  invoice, invoice_event, clawback, clawback_recovery, partner_billing, rate_card, tax_rate TO vittora_ops;
GRANT UPDATE (status, relook_from, status_changed_at, assignee_ops_id, lender_id, sanctioned_amount_paise,
  sanctioned_roi_bps, sanctioned_tenure_months, disbursed_at, updated_at, version) ON loan_case TO vittora_ops;
GRANT INSERT ON case_status_history, disbursal, case_reversal, notification, invoice, invoice_event, clawback,
  clawback_recovery, rate_card TO vittora_ops;
GRANT UPDATE (status, decided_by, decided_at) ON case_reversal TO vittora_ops;
GRANT UPDATE (status, gross_paise, gst_paise, tds_paise, net_paise, recovered_paise, rate_card_snapshot, approved_at,
  paid_at, payout_ref, payout_requested_by, payout_confirmed_by, updated_at, version) ON invoice TO vittora_ops;
GRANT UPDATE (status, approved_by, decided_at, recovered_paise) ON clawback TO vittora_ops;
GRANT UPDATE (status, approved_by, decided_at) ON rate_card TO vittora_ops;
GRANT UPDATE (verification_status, reviewer_note, verified_at, verified_by) ON partner_billing TO vittora_ops;
-- Location only. Names, phones, PAN and address stay out of reach of the ops console.
GRANT SELECT (id, partner_id, city, state, pincode) ON applicant TO vittora_ops;
GRANT SELECT (id, case_id, purpose, consented_at) ON customer_consent TO vittora_ops;
