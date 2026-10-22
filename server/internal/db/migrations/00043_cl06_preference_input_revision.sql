-- +goose Up
ALTER TABLE platform_account
  ADD COLUMN pref_input_revision bigint NOT NULL DEFAULT 1 CHECK (pref_input_revision > 0),
  ADD COLUMN pref_processed_revision bigint;

ALTER TABLE account_data_preference
  ADD COLUMN basis_meta jsonb;

-- Existing accounts are queued once for basis validation; new empty accounts start clean.
-- +goose StatementBegin
CREATE FUNCTION initialize_pref_input_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.pref_processed_revision := coalesce(NEW.pref_processed_revision, NEW.pref_input_revision);
  RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER platform_account_pref_input_revision_init
  BEFORE INSERT ON platform_account
  FOR EACH ROW EXECUTE FUNCTION initialize_pref_input_revision();

-- +goose StatementBegin
CREATE FUNCTION bump_pref_input_revision(p_account_id uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE platform_account SET pref_input_revision=pref_input_revision+1 WHERE id=p_account_id
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION metric_snapshot_pref_input_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_account uuid;
  new_account uuid;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW.work_id, NEW.captured_at, NEW.reads, NEW.likes, NEW.wows, NEW.favorites,
      NEW.comments, NEW.shares, NEW.source, NEW.day_offset)
     IS NOT DISTINCT FROM
     (OLD.work_id, OLD.captured_at, OLD.reads, OLD.likes, OLD.wows, OLD.favorites,
      OLD.comments, OLD.shares, OLD.source, OLD.day_offset) THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT account_id INTO old_account FROM work WHERE id=OLD.work_id AND deleted_at IS NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT account_id INTO new_account FROM work WHERE id=NEW.work_id AND deleted_at IS NULL;
  END IF;
  IF old_account IS NOT NULL THEN
    PERFORM bump_pref_input_revision(old_account);
  END IF;
  IF new_account IS NOT NULL AND new_account IS DISTINCT FROM old_account THEN
    PERFORM bump_pref_input_revision(new_account);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER metric_snapshot_pref_input_revision
  AFTER INSERT OR UPDATE OR DELETE ON metric_snapshot
  FOR EACH ROW EXECUTE FUNCTION metric_snapshot_pref_input_revision();

-- +goose StatementBegin
CREATE FUNCTION work_pref_input_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_account uuid;
  new_account uuid;
  changed boolean;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    changed := (NEW.title, NEW.topics, NEW.published_at, NEW.deleted_at, NEW.account_id)
      IS DISTINCT FROM (OLD.title, OLD.topics, OLD.published_at, OLD.deleted_at, OLD.account_id)
      OR ((NEW.published_at IS NULL OR OLD.published_at IS NULL) AND NEW.updated_at IS DISTINCT FROM OLD.updated_at);
    IF NOT changed THEN
      RETURN NEW;
    END IF;
    IF OLD.deleted_at IS NULL AND EXISTS (SELECT 1 FROM work_metric_d7 d WHERE d.work_id=OLD.id AND d.reads IS NOT NULL) THEN
      old_account := OLD.account_id;
    END IF;
    IF NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM work_metric_d7 d WHERE d.work_id=NEW.id AND d.reads IS NOT NULL) THEN
      new_account := NEW.account_id;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM work_metric_d7 d WHERE d.work_id=NEW.id AND d.reads IS NOT NULL) THEN
      new_account := NEW.account_id;
    END IF;
  ELSE
    IF OLD.deleted_at IS NULL AND EXISTS (SELECT 1 FROM work_metric_d7 d WHERE d.work_id=OLD.id AND d.reads IS NOT NULL) THEN
      old_account := OLD.account_id;
    END IF;
  END IF;
  IF old_account IS NOT NULL THEN
    PERFORM bump_pref_input_revision(old_account);
  END IF;
  IF new_account IS NOT NULL AND new_account IS DISTINCT FROM old_account THEN
    PERFORM bump_pref_input_revision(new_account);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER work_pref_input_revision
  AFTER INSERT OR UPDATE ON work
  FOR EACH ROW EXECUTE FUNCTION work_pref_input_revision();

CREATE TRIGGER work_pref_input_revision_delete
  BEFORE DELETE ON work
  FOR EACH ROW EXECUTE FUNCTION work_pref_input_revision();

-- +goose StatementBegin
CREATE FUNCTION work_section_pref_input_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_account uuid;
  new_account uuid;
  old_chars integer := 0;
  new_chars integer := 0;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.deleted_at IS NULL THEN
    old_chars := char_length(coalesce(OLD.content_md, ''));
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.deleted_at IS NULL THEN
    new_chars := char_length(coalesce(NEW.content_md, ''));
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.work_id=NEW.work_id AND old_chars=new_chars THEN
    RETURN NEW;
  END IF;
  IF old_chars > 0 THEN
    SELECT w.account_id INTO old_account FROM work w JOIN work_metric_d7 d ON d.work_id=w.id AND d.reads IS NOT NULL
      WHERE w.id=OLD.work_id AND w.deleted_at IS NULL;
  END IF;
  IF new_chars > 0 THEN
    SELECT w.account_id INTO new_account FROM work w JOIN work_metric_d7 d ON d.work_id=w.id AND d.reads IS NOT NULL
      WHERE w.id=NEW.work_id AND w.deleted_at IS NULL;
  END IF;
  IF old_account IS NOT NULL THEN
    PERFORM bump_pref_input_revision(old_account);
  END IF;
  IF new_account IS NOT NULL AND new_account IS DISTINCT FROM old_account THEN
    PERFORM bump_pref_input_revision(new_account);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER work_section_pref_input_revision
  AFTER INSERT OR UPDATE OR DELETE ON work_section
  FOR EACH ROW EXECUTE FUNCTION work_section_pref_input_revision();

-- +goose Down
DROP TRIGGER work_section_pref_input_revision ON work_section;
DROP FUNCTION work_section_pref_input_revision();
DROP TRIGGER work_pref_input_revision_delete ON work;
DROP TRIGGER work_pref_input_revision ON work;
DROP FUNCTION work_pref_input_revision();
DROP TRIGGER metric_snapshot_pref_input_revision ON metric_snapshot;
DROP FUNCTION metric_snapshot_pref_input_revision();
DROP FUNCTION bump_pref_input_revision(uuid);
DROP TRIGGER platform_account_pref_input_revision_init ON platform_account;
DROP FUNCTION initialize_pref_input_revision();
ALTER TABLE account_data_preference DROP COLUMN basis_meta;
ALTER TABLE platform_account DROP COLUMN pref_processed_revision, DROP COLUMN pref_input_revision;
