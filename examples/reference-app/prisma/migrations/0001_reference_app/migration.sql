CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tenant_memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('applicant','reviewer','admin')),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_user_idx ON tenant_memberships(user_id);
CREATE TABLE permits (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  permit_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','submitted','under_review','approved','rejected','cancelled')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  applicant_name TEXT NOT NULL,
  applicant_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, permit_number)
);
CREATE INDEX permits_tenant_state_idx ON permits(tenant_id, state);
CREATE TABLE permit_documents (
  id TEXT PRIMARY KEY,
  permit_id TEXT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX permit_documents_permit_idx ON permit_documents(permit_id);
CREATE TABLE review_assignments (
  id TEXT PRIMARY KEY,
  permit_id TEXT NOT NULL UNIQUE REFERENCES permits(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_assignments_reviewer_idx ON review_assignments(reviewer_id);
CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY,
  permit_id TEXT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  transition_id TEXT NOT NULL UNIQUE,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_decisions_permit_idx ON review_decisions(permit_id, created_at);
CREATE TABLE delivered_notifications (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  worker_id TEXT NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION bump_permit_version_for_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE permits SET version = version + 1, updated_at = now()
  WHERE id = COALESCE(NEW.permit_id, OLD.permit_id);
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER permit_document_version
AFTER INSERT OR UPDATE OR DELETE ON permit_documents
FOR EACH ROW EXECUTE FUNCTION bump_permit_version_for_document();
