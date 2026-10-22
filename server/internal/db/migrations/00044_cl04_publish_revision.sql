-- +goose Up
ALTER TABLE work
  ADD COLUMN publish_revision integer NOT NULL DEFAULT 1 CHECK (publish_revision > 0);

-- Publication metadata has its own concurrency basis; content revisions remain independent.
-- +goose StatementBegin
CREATE FUNCTION work_bump_publish_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.published_url, NEW.published_at) IS DISTINCT FROM (OLD.published_url, OLD.published_at) THEN
    NEW.publish_revision := OLD.publish_revision + 1;
  ELSE
    NEW.publish_revision := OLD.publish_revision;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER work_publish_revision
  BEFORE UPDATE OF published_url, published_at ON work
  FOR EACH ROW EXECUTE FUNCTION work_bump_publish_revision();

-- Date correction may shift a set of unique node keys together. Deferred validation lets
-- intermediate row order change without accepting duplicate final keys.
DROP INDEX metric_snapshot_node;
ALTER TABLE metric_snapshot
  ADD CONSTRAINT metric_snapshot_node UNIQUE (work_id, source, day_offset) DEFERRABLE INITIALLY IMMEDIATE;

-- +goose Down
ALTER TABLE metric_snapshot DROP CONSTRAINT metric_snapshot_node;
CREATE UNIQUE INDEX metric_snapshot_node ON metric_snapshot (work_id, source, day_offset);
DROP TRIGGER work_publish_revision ON work;
DROP FUNCTION work_bump_publish_revision();
ALTER TABLE work DROP COLUMN publish_revision;
