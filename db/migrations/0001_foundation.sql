-- Part 1 foundation: tenants, users, sessions, one-time tokens, login attempts, audit log.
-- Roles: vittora_owner runs migrations; vittora_auth serves sign-in only;
-- vittora_app serves everything else and is always bound by Row-Level Security.

CREATE TABLE partner (
  id            uuid PRIMARY KEY,
  ref_code      text NOT NULL UNIQUE,
  legal_name    text NOT NULL,
  channel_name  text NOT NULL,
  city          text NOT NULL,
  pincode       text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  employee_band text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  kyc_status    text NOT NULL DEFAULT 'not_started'
                CHECK (kyc_status IN ('not_started','submitted','approved','rejected')),
  features      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id             uuid PRIMARY KEY,
  partner_id     uuid REFERENCES partner(id),
  name           text NOT NULL,
  email          text NOT NULL,
  phone          text,
  role           text NOT NULL CHECK (role IN (
                   'admin','manager','executive','viewer',
                   'ops_agent','ops_lead','kyc_reviewer','finance','super_admin')),
  status         text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','inactive')),
  password_hash  text,
  mfa_enabled    boolean NOT NULL DEFAULT false,
  mfa_secret_enc text,
  mfa_last_step  bigint,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_by     uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Internal roles can never exist inside a partner tenant, and partner roles always need one.
  CONSTRAINT role_matches_realm CHECK (
    (partner_id IS NULL) = (role IN ('ops_agent','ops_lead','kyc_reviewer','finance','super_admin'))
  )
);
CREATE UNIQUE INDEX app_user_email_key ON app_user (lower(email));
CREATE INDEX app_user_partner_idx ON app_user (partner_id);

CREATE TABLE session (
  id_hash      text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app_user(id),
  partner_id   uuid REFERENCES partner(id),
  mfa_state    text NOT NULL CHECK (mfa_state IN ('pending','enroll','ok')),
  mfa_failures integer NOT NULL DEFAULT 0,
  ip           text,
  user_agent   text,
  device_hash  text NOT NULL,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX session_user_idx ON session (user_id);

CREATE TABLE auth_token (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id),
  purpose    text NOT NULL CHECK (purpose IN ('password_setup','password_reset','email_otp')),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX auth_token_hash_idx ON auth_token (token_hash);
CREATE INDEX auth_token_user_idx ON auth_token (user_id, purpose);

CREATE TABLE login_attempt (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_hash text NOT NULL,
  ip         text,
  success    boolean NOT NULL,
  at         timestamptz NOT NULL
);
CREATE INDEX login_attempt_email_idx ON login_attempt (email_hash, at DESC);

-- Append-only and hash-chained. Must never hold PII: entity ids and codes only.
CREATE TABLE audit_log (
  seq        bigint PRIMARY KEY,
  id         uuid NOT NULL,
  actor_id   uuid,
  partner_id uuid,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  ip         text,
  user_agent text,
  reason     text,
  before     jsonb,
  after      jsonb,
  at         timestamptz NOT NULL,
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);
CREATE INDEX audit_log_partner_idx ON audit_log (partner_id, seq DESC);
CREATE SEQUENCE audit_log_seq;

CREATE FUNCTION audit_log_digest(r audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    r.prev_hash, r.seq::text, r.id::text, coalesce(r.actor_id::text,''), coalesce(r.partner_id::text,''),
    r.action, coalesce(r.entity,''), coalesce(r.entity_id,''), coalesce(r.ip,''),
    coalesce(r.user_agent,''), coalesce(r.reason,''), coalesce(r.before::text,''),
    coalesce(r.after::text,''), extract(epoch FROM r.at)::text
  ), 'UTF8')), 'hex')
$$;

CREATE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);
  SELECT hash INTO last_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.seq := nextval('audit_log_seq');
  NEW.at := clock_timestamp();
  NEW.prev_hash := coalesce(last_hash, 'GENESIS');
  NEW.hash := audit_log_digest(NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Returns the seq of the first broken row, or NULL when the chain is intact.
CREATE FUNCTION audit_log_verify() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r audit_log; expected text := 'GENESIS';
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY seq LOOP
    IF r.prev_hash <> expected OR r.hash <> audit_log_digest(r) THEN RETURN r.seq; END IF;
    expected := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Row-Level Security: tenant comes from SET LOCAL app.partner_id, set from the session.
CREATE FUNCTION current_partner_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.partner_id', true), '')::uuid
$$;

ALTER TABLE partner   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_partner ON partner FOR SELECT TO vittora_app USING (id = current_partner_id());
CREATE POLICY tenant_user ON app_user FOR ALL TO vittora_app
  USING (partner_id = current_partner_id()) WITH CHECK (partner_id = current_partner_id());
CREATE POLICY tenant_audit_read ON audit_log FOR SELECT TO vittora_app USING (partner_id = current_partner_id());
CREATE POLICY tenant_audit_write ON audit_log FOR INSERT TO vittora_app WITH CHECK (partner_id = current_partner_id());

CREATE POLICY auth_partner ON partner FOR SELECT TO vittora_auth USING (true);
CREATE POLICY auth_user ON app_user FOR ALL TO vittora_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_audit_write ON audit_log FOR INSERT TO vittora_auth WITH CHECK (true);

-- vittora_app can't read password hashes or MFA secrets at all.
GRANT SELECT ON partner TO vittora_app, vittora_auth;
GRANT SELECT (id, partner_id, name, email, phone, role, status, mfa_enabled, last_login_at, created_at)
  ON app_user TO vittora_app;
GRANT SELECT, UPDATE ON app_user TO vittora_auth;
GRANT SELECT, INSERT, UPDATE ON session, auth_token TO vittora_auth;
GRANT SELECT, INSERT ON login_attempt TO vittora_auth;
GRANT SELECT, INSERT ON audit_log TO vittora_app;
GRANT INSERT ON audit_log TO vittora_auth;
GRANT EXECUTE ON FUNCTION audit_log_verify() TO vittora_auth;
