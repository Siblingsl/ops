-- +goose Up
ALTER TABLE work ADD COLUMN wechat_msgid text;
UPDATE work SET wechat_msgid = substring(published_url from '[?&]mid=([0-9]+)') || '_' || substring(published_url from '[?&]idx=([0-9]+)')
  WHERE published_url ~ '[?&]mid=[0-9]+' AND published_url ~ '[?&]idx=[0-9]+';
CREATE INDEX work_wechat_msgid ON work (account_id, wechat_msgid) WHERE wechat_msgid IS NOT NULL;

ALTER TABLE platform_account
  ADD COLUMN datacube_state text NOT NULL DEFAULT 'unknown' CHECK (datacube_state IN ('ok','no_permission','unknown')),
  ADD COLUMN datacube_checked_at timestamptz;

CREATE TABLE metric_unmatched (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  title        text NOT NULL DEFAULT '',
  ref_date     date NOT NULL,
  details      jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason       text NOT NULL DEFAULT 'none' CHECK (reason IN ('none','ambiguous')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','assigned','ignored')),
  work_id      uuid REFERENCES work(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

-- Interface snapshots carry the day offset reported by WeChat (stat_date - ref_date); keep it.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_fill_offset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.day_offset IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.source = 'wechat_api') THEN
    RETURN NEW;
  END IF;
  SELECT metric_day_offset(NEW.captured_at, w.published_at) INTO NEW.day_offset FROM work w WHERE w.id = NEW.work_id;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_fill_offset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.day_offset IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT metric_day_offset(NEW.captured_at, w.published_at) INTO NEW.day_offset FROM work w WHERE w.id = NEW.work_id;
  RETURN NEW;
END
$$;
-- +goose StatementEnd
DROP TABLE metric_unmatched;
ALTER TABLE platform_account DROP COLUMN datacube_checked_at, DROP COLUMN datacube_state;
DROP INDEX work_wechat_msgid;
ALTER TABLE work DROP COLUMN wechat_msgid;
