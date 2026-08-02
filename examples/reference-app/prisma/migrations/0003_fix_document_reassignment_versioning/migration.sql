CREATE OR REPLACE FUNCTION bump_permit_version_for_document()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.permit_id IS DISTINCT FROM OLD.permit_id THEN
    IF OLD.permit_id IS NULL THEN
      UPDATE permits
      SET version = version + 1, updated_at = now()
      WHERE id = NEW.permit_id;
    ELSIF NEW.permit_id IS NULL THEN
      UPDATE permits
      SET version = version + 1, updated_at = now()
      WHERE id = OLD.permit_id;
    ELSIF OLD.permit_id < NEW.permit_id THEN
      UPDATE permits
      SET version = version + 1, updated_at = now()
      WHERE id = OLD.permit_id;

      UPDATE permits
      SET version = version + 1, updated_at = now()
      WHERE id = NEW.permit_id;
    ELSE
      UPDATE permits
      SET version = version + 1, updated_at = now()
      WHERE id = NEW.permit_id;

      UPDATE permits
      SET version = version + 1, updated_at = now()
      WHERE id = OLD.permit_id;
    END IF;
  ELSE
    UPDATE permits
    SET version = version + 1, updated_at = now()
    WHERE id = COALESCE(NEW.permit_id, OLD.permit_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
