-- +goose Up
CREATE TABLE crawl_source (
  key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('hotlist','rss','search','aggregator','xhs_page','wechat_page')),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  interval_min int NOT NULL DEFAULT 60 CHECK (interval_min >= 10),
  max_items int NOT NULL DEFAULT 50 CHECK (max_items BETWEEN 1 AND 100),
  config jsonb NOT NULL DEFAULT '{}',
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  fail_count int NOT NULL DEFAULT 0,
  paused_until timestamptz,
  last_ok_at timestamptz,
  last_attempt_at timestamptz,
  robots_checked_at timestamptz,
  robots_allow boolean,
  error text NOT NULL DEFAULT ''
);
INSERT INTO crawl_source (key,kind,name,config) VALUES
 ('baidu','hotlist','百度热搜','{"url":"https://top.baidu.com/board?tab=realtime"}'),
 ('toutiao','hotlist','头条热榜','{"url":"https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc"}'),
 ('xhs_page','xhs_page','小红书页面','{}'),
 ('wechat_page','wechat_page','公众号页面','{}');
UPDATE crawl_source SET robots_allow=false,error='robots 不允许' WHERE kind IN ('xhs_page','wechat_page');

CREATE TABLE crawl_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL REFERENCES crawl_source(key) ON DELETE CASCADE,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 requests int NOT NULL DEFAULT 0, http_status int NOT NULL DEFAULT 0,
 items int NOT NULL DEFAULT 0, error text NOT NULL DEFAULT ''
);
CREATE INDEX crawl_run_recent ON crawl_run(started_at DESC);

CREATE TABLE hot_cluster (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL,
 sources text[] NOT NULL DEFAULT '{}', best_rank int NOT NULL DEFAULT 0,
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hot_item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL REFERENCES crawl_source(key) ON DELETE CASCADE,
 title text NOT NULL, title_norm text NOT NULL, url text NOT NULL,
 rank int NOT NULL DEFAULT 0, heat text NOT NULL DEFAULT '', category text NOT NULL DEFAULT '',
 summary text NOT NULL DEFAULT '', cluster_id uuid REFERENCES hot_cluster(id) ON DELETE SET NULL,
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 best_rank int NOT NULL DEFAULT 0,
 UNIQUE(source_key,title_norm,url)
);
CREATE INDEX hot_item_recent ON hot_item(last_seen_at DESC);
CREATE INDEX hot_item_cluster ON hot_item(cluster_id);

CREATE TABLE account_hot_match (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
 date date NOT NULL, hot_item_id uuid NOT NULL REFERENCES hot_item(id) ON DELETE CASCADE,
 relevance int NOT NULL CHECK (relevance BETWEEN 0 AND 100), reason text NOT NULL DEFAULT '',
 angle text NOT NULL DEFAULT '', risk text[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','converted','dismissed')),
 topic_id uuid REFERENCES topic(id) ON DELETE SET NULL, ai_call_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,date,hot_item_id)
);
CREATE TABLE account_hot_refresh (
 account_id uuid PRIMARY KEY REFERENCES platform_account(id) ON DELETE CASCADE,
 refreshed_at timestamptz NOT NULL
);
CREATE TABLE crawl_budget (
 date date PRIMARY KEY, requests int NOT NULL DEFAULT 0,
 summary_requests int NOT NULL DEFAULT 0
);
INSERT INTO system_setting(key,value) VALUES
 ('crawl.level','"off"'),
 ('crawl.limits','{"interval_min":60,"max_items":50,"daily_requests":300,"fail_limit":3,"pause_hours":6}'),
 ('crawl.summary_fetch','false'), ('crawl.retention_days','14')
 ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM system_setting WHERE key IN ('crawl.level','crawl.limits','crawl.summary_fetch','crawl.retention_days');
DROP TABLE account_hot_refresh, account_hot_match, hot_item, hot_cluster, crawl_run, crawl_source, crawl_budget;
