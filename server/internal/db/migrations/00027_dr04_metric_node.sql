-- +goose Up
-- getarticletotal reports days 0–6, so day 6 counts toward the 7-day node.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_node(day_offset int) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN day_offset IS NULL OR day_offset < 1 THEN NULL
    WHEN day_offset < 3 THEN 1
    WHEN day_offset < 6 THEN 3
    WHEN day_offset < 30 THEN 7
    ELSE 30 END
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_node(day_offset int) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN day_offset IS NULL OR day_offset < 1 THEN NULL
    WHEN day_offset < 3 THEN 1
    WHEN day_offset < 7 THEN 3
    WHEN day_offset < 30 THEN 7
    ELSE 30 END
$$;
-- +goose StatementEnd
