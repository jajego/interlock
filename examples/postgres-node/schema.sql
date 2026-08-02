CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  decision_note TEXT
);
CREATE TABLE application_documents (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  verified BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE FUNCTION bump_application_version_for_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.application_id IS DISTINCT FROM OLD.application_id THEN
    UPDATE applications
    SET version = version + 1
    WHERE id IN (OLD.application_id, NEW.application_id);
  ELSE
    UPDATE applications
    SET version = version + 1
    WHERE id = COALESCE(NEW.application_id, OLD.application_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER application_documents_bump_version
AFTER INSERT OR UPDATE OR DELETE ON application_documents
FOR EACH ROW EXECUTE FUNCTION bump_application_version_for_document();
CREATE TABLE application_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  transition_id TEXT NOT NULL,
  note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL
);
