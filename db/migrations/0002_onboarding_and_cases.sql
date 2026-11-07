-- Parts 2 and 3: partner onboarding, KYC, product catalogue, drafts, consent and cases.
-- vittora_ops serves the internal console and sees across tenants, but only what is granted here.

ALTER TABLE partner ADD COLUMN business_email text, ADD COLUMN business_phone text;
CREATE SEQUENCE partner_ref_seq START 1000;

CREATE TABLE partner_agreement (
  id            uuid PRIMARY KEY,
  partner_id    uuid NOT NULL REFERENCES partner(id),
  version       text NOT NULL,
  document_hash text NOT NULL,
  accepted_by   uuid NOT NULL REFERENCES app_user(id),
  accepted_at   timestamptz NOT NULL,
  ip            text,
  UNIQUE (partner_id, version)
);

CREATE TABLE product (
  code           text PRIMARY KEY,
  name           text NOT NULL,
  active         boolean NOT NULL DEFAULT false,
  schema_version integer NOT NULL DEFAULT 1
);
INSERT INTO product (code, name, active) VALUES
  ('used_car', 'Used Car Loan', true),
  ('loan_against_car', 'Loan Against Car', true),
  ('personal', 'Personal Loan', true),
  ('business', 'Business Loan', false),
  ('home', 'Home Loan', false),
  ('education', 'Education Loan', false);

CREATE TABLE partner_product (
  partner_id   uuid NOT NULL REFERENCES partner(id),
  product_code text NOT NULL REFERENCES product(code),
  enabled_at   timestamptz NOT NULL,
  PRIMARY KEY (partner_id, product_code)
);

CREATE TABLE lender (
  id     uuid PRIMARY KEY,
  name   text NOT NULL,
  type   text NOT NULL CHECK (type IN ('bank','nbfc')),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE lender_product (
  lender_id    uuid NOT NULL REFERENCES lender(id),
  product_code text NOT NULL REFERENCES product(code),
  active       boolean NOT NULL DEFAULT true,
  PRIMARY KEY (lender_id, product_code)
);

CREATE TABLE kyc_document (
  id            uuid PRIMARY KEY,
  partner_id    uuid NOT NULL REFERENCES partner(id),
  type          text NOT NULL CHECK (type IN ('pan','gst_certificate','address_proof','bank_details')),
  object_key    text NOT NULL,
  file_name     text NOT NULL,
  mime          text NOT NULL,
  sha256        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer_note text,
  submitted_at  timestamptz NOT NULL,
  reviewed_at   timestamptz,
  reviewed_by   uuid REFERENCES app_user(id),
  UNIQUE (partner_id, type)
);

CREATE TABLE case_draft (
  id              uuid PRIMARY KEY,
  partner_id      uuid NOT NULL REFERENCES partner(id),
  created_by      uuid NOT NULL REFERENCES app_user(id),
  idempotency_key text NOT NULL,
  product         text REFERENCES product(code),
  data_enc        text NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted')),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  UNIQUE (partner_id, created_by, idempotency_key)
);
CREATE INDEX case_draft_owner_idx ON case_draft (partner_id, created_by, updated_at DESC);

CREATE TABLE applicant (
  id            uuid PRIMARY KEY,
  partner_id    uuid NOT NULL REFERENCES partner(id),
  full_name_enc text NOT NULL,
  phone_enc     text NOT NULL,
  phone_hash    text NOT NULL,
  email_enc     text,
  pan_enc       text NOT NULL,
  pan_hash      text NOT NULL,
  aadhaar_last4 text NOT NULL CHECK (aadhaar_last4 ~ '^[0-9]{4}$'),
  dob_enc       text NOT NULL,
  address_enc   text NOT NULL,
  pincode       text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  city          text NOT NULL,
  state         text NOT NULL
);
CREATE INDEX applicant_pan_idx ON applicant (partner_id, pan_hash);
CREATE INDEX applicant_phone_idx ON applicant (partner_id, phone_hash);

CREATE TABLE loan_case (
  id                   uuid PRIMARY KEY,
  case_no              text NOT NULL UNIQUE,
  partner_id           uuid NOT NULL REFERENCES partner(id),
  created_by_user_id   uuid NOT NULL REFERENCES app_user(id),
  assignee_ops_id      uuid REFERENCES app_user(id),
  source_draft_id      uuid NOT NULL UNIQUE REFERENCES case_draft(id),
  case_type            text NOT NULL CHECK (case_type IN ('open_market','in_house')),
  product              text NOT NULL REFERENCES product(code),
  details_schema_version integer NOT NULL,
  loan_type            text NOT NULL,
  preferred_lender_id  uuid NOT NULL REFERENCES lender(id),
  applicant_id         uuid NOT NULL REFERENCES applicant(id),
  status               text NOT NULL DEFAULT 'REGISTERED' CHECK (status IN (
                         'REGISTERED','IN_REVIEW','APPROVED','CUSTOMER_APPROVED','DISBURSAL_IN_PROGRESS',
                         'DISBURSED','REVERSED','RELOOK','REJECTED','WITHDRAWN')),
  loan_amount_paise    bigint NOT NULL CHECK (loan_amount_paise > 0),
  tenure_months        integer NOT NULL CHECK (tenure_months > 0),
  purpose              text,
  employment_type      text NOT NULL,
  monthly_income_paise bigint NOT NULL CHECK (monthly_income_paise >= 0),
  existing_emi_paise   bigint NOT NULL DEFAULT 0 CHECK (existing_emi_paise >= 0),
  company_name         text,
  work_experience_years integer,
  bureau_score         integer,
  product_details      jsonb NOT NULL,
  collateral_key_hash  text,
  possible_duplicate   boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  disbursed_at         timestamptz,
  version              integer NOT NULL DEFAULT 1
);
CREATE INDEX loan_case_status_idx ON loan_case (partner_id, status, created_at DESC);
CREATE INDEX loan_case_owner_idx ON loan_case (partner_id, created_by_user_id, created_at DESC);

CREATE TABLE case_document (
  id          uuid PRIMARY KEY,
  partner_id  uuid NOT NULL REFERENCES partner(id),
  draft_id    uuid NOT NULL REFERENCES case_draft(id),
  case_id     uuid REFERENCES loan_case(id),
  doc_type    text NOT NULL,
  object_key  text NOT NULL,
  file_name   text NOT NULL,
  mime        text NOT NULL,
  sha256      text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES app_user(id),
  at          timestamptz NOT NULL,
  UNIQUE (draft_id, doc_type)
);

CREATE TABLE case_status_history (
  id          uuid PRIMARY KEY,
  partner_id  uuid NOT NULL REFERENCES partner(id),
  case_id     uuid NOT NULL REFERENCES loan_case(id),
  from_status text,
  to_status   text NOT NULL,
  actor_id    uuid NOT NULL REFERENCES app_user(id),
  reason_code text,
  note        text,
  at          timestamptz NOT NULL
);
CREATE INDEX case_status_history_idx ON case_status_history (case_id, at);

-- Consent comes from the customer, through their own link, never from the partner's screen.
CREATE TABLE customer_consent (
  id             uuid PRIMARY KEY,
  partner_id     uuid NOT NULL REFERENCES partner(id),
  draft_id       uuid NOT NULL REFERENCES case_draft(id),
  case_id        uuid REFERENCES loan_case(id),
  purpose        text NOT NULL CHECK (purpose IN ('processing','bureau')),
  text_version   text NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('otp','link')),
  lender_name    text NOT NULL,
  recipient_hash text NOT NULL,
  pan_hash       text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  superseded_at  timestamptz,
  consented_at   timestamptz,
  customer_ip    text,
  user_agent     text,
  created_at     timestamptz NOT NULL
);
CREATE INDEX customer_consent_draft_idx ON customer_consent (draft_id);

-- Partners never learn whether another partner has the same customer; ops sees the flag.
CREATE FUNCTION case_duplicate_elsewhere(p_pan_hash text, p_product text, p_collateral text, p_partner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM loan_case c JOIN applicant a ON a.id = c.applicant_id
    WHERE c.partner_id <> p_partner AND a.pan_hash = p_pan_hash AND c.product = p_product
      AND (p_collateral IS NULL OR c.collateral_key_hash = p_collateral)
      AND c.status NOT IN ('REJECTED','WITHDRAWN','REVERSED')
  )
$$;

-- The only way a partner can change its own KYC status, and only to 'submitted'.
CREATE FUNCTION partner_submit_kyc() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE partner SET kyc_status = 'submitted'
  WHERE id = current_partner_id() AND kyc_status IN ('not_started','rejected');
  RETURN FOUND;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_agreement','partner_product','kyc_document','case_draft','applicant',
                           'loan_case','case_document','case_status_history','customer_consent'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_all ON %I FOR ALL TO vittora_app
                    USING (partner_id = current_partner_id()) WITH CHECK (partner_id = current_partner_id())', t);
  END LOOP;
END $$;

-- An approved KYC document can't be removed by the partner.
DROP POLICY tenant_all ON kyc_document;
CREATE POLICY tenant_read ON kyc_document FOR SELECT TO vittora_app USING (partner_id = current_partner_id());
CREATE POLICY tenant_insert ON kyc_document FOR INSERT TO vittora_app WITH CHECK (partner_id = current_partner_id());
CREATE POLICY tenant_delete ON kyc_document FOR DELETE TO vittora_app
  USING (partner_id = current_partner_id() AND status <> 'approved');

GRANT SELECT ON product, lender, lender_product TO vittora_app, vittora_ops;
GRANT SELECT, INSERT ON partner_agreement, partner_product TO vittora_app;
GRANT SELECT, DELETE ON kyc_document TO vittora_app;
GRANT INSERT (id, partner_id, type, object_key, file_name, mime, sha256, submitted_at) ON kyc_document TO vittora_app;
GRANT SELECT, INSERT, UPDATE ON case_draft, customer_consent TO vittora_app;
GRANT SELECT, INSERT ON applicant, loan_case, case_status_history TO vittora_app;
GRANT SELECT, INSERT, DELETE, UPDATE ON case_document TO vittora_app;
GRANT EXECUTE ON FUNCTION case_duplicate_elsewhere(text, text, text, uuid), partner_submit_kyc() TO vittora_app;

-- Sign-up and the public consent page run before any tenant is known.
CREATE POLICY auth_partner_insert ON partner FOR INSERT TO vittora_auth WITH CHECK (true);
CREATE POLICY auth_product ON partner_product FOR INSERT TO vittora_auth WITH CHECK (true);
CREATE POLICY auth_consent ON customer_consent FOR ALL TO vittora_auth USING (true) WITH CHECK (true);
GRANT INSERT ON partner, app_user, partner_product TO vittora_auth;
GRANT USAGE ON SEQUENCE partner_ref_seq TO vittora_auth;
GRANT SELECT, UPDATE ON customer_consent TO vittora_auth;

-- The ops console reads partners and KYC across tenants. It has no access to customer PII here.
CREATE POLICY ops_partner ON partner FOR ALL TO vittora_ops USING (true) WITH CHECK (true);
CREATE POLICY ops_kyc ON kyc_document FOR ALL TO vittora_ops USING (true) WITH CHECK (true);
CREATE POLICY ops_user ON app_user FOR SELECT TO vittora_ops USING (true);
CREATE POLICY ops_audit ON audit_log FOR INSERT TO vittora_ops WITH CHECK (true);
GRANT SELECT ON partner TO vittora_ops;
GRANT UPDATE (status, kyc_status) ON partner TO vittora_ops;
GRANT SELECT ON kyc_document TO vittora_ops;
GRANT UPDATE (status, reviewer_note, reviewed_at, reviewed_by) ON kyc_document TO vittora_ops;
GRANT SELECT (id, partner_id, name, email, role, status) ON app_user TO vittora_ops;
GRANT INSERT ON audit_log TO vittora_ops;
