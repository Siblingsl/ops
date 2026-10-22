-- +goose Up
ALTER TABLE metric_snapshot
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);

-- +goose StatementBegin
CREATE FUNCTION metric_snapshot_bump_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.work_id, NEW.captured_at, NEW.reads, NEW.likes, NEW.wows, NEW.favorites,
      NEW.comments, NEW.shares, NEW.follows_gained, NEW.note, NEW.source, NEW.day_offset, NEW.external_id)
     IS DISTINCT FROM
     (OLD.work_id, OLD.captured_at, OLD.reads, OLD.likes, OLD.wows, OLD.favorites,
      OLD.comments, OLD.shares, OLD.follows_gained, OLD.note, OLD.source, OLD.day_offset, OLD.external_id) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER metric_snapshot_revision
  BEFORE UPDATE ON metric_snapshot
  FOR EACH ROW EXECUTE FUNCTION metric_snapshot_bump_revision();

-- +goose Down
DROP TRIGGER metric_snapshot_revision ON metric_snapshot;
DROP FUNCTION metric_snapshot_bump_revision();
ALTER TABLE metric_snapshot DROP COLUMN revision;
