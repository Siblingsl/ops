-- +goose Up
CREATE TABLE crawl_platform_state (
 platform text PRIMARY KEY CHECK(platform IN ('xhs_page','wechat_page')),
 enabled boolean NOT NULL DEFAULT false, level text NOT NULL DEFAULT 'conservative' CHECK(level IN ('conservative','standard')),
 interval_min int NOT NULL DEFAULT 10 CHECK(interval_min>=3), daily_max int NOT NULL DEFAULT 30 CHECK(daily_max BETWEEN 1 AND 100),
 repeat_hours int NOT NULL DEFAULT 72 CHECK(repeat_hours>=12), jitter_min int NOT NULL DEFAULT 5 CHECK(jitter_min BETWEEN 0 AND 5),
 request_date date, today_requests int NOT NULL DEFAULT 0, last_request_at timestamptz, next_request_at timestamptz,
 paused_until timestamptz, strikes_7d int NOT NULL DEFAULT 0, last_strike_at timestamptz
);
INSERT INTO crawl_platform_state(platform) VALUES ('xhs_page'),('wechat_page');
CREATE TABLE crawl_platform_read(platform text REFERENCES crawl_platform_state(platform),url text,last_read_at timestamptz NOT NULL,PRIMARY KEY(platform,url));
-- +goose Down
DROP TABLE crawl_platform_read;
DROP TABLE crawl_platform_state;
