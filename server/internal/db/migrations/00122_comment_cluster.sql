-- +goose Up
-- REF41 I3：读者提问归并与关注点。
-- 同一问题被 >=2 条评论提及时形成问题簇；归并由 canonical_key 去重，
-- 样例只保留评论正文/平台/时间，不落评论者身份；软删评论只在下一次重算时降计数。
-- topic.source 增加 comment（保留既有 manual/ai/review/hot/inbox/plan/daily）。

ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_source_check;
ALTER TABLE topic ADD CONSTRAINT topic_source_check
  CHECK (source IN ('manual', 'ai', 'review', 'hot', 'inbox', 'plan', 'daily', 'comment'));

ALTER TABLE comment_inbox ADD COLUMN canonical_key text NOT NULL DEFAULT '';
ALTER TABLE comment_inbox ADD COLUMN intent_confidence numeric(3,2)
  CHECK (intent_confidence IS NULL OR (intent_confidence >= 0 AND intent_confidence <= 1));

CREATE TABLE comment_question_cluster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  canonical_key text NOT NULL,
  question_text text NOT NULL CHECK (char_length(question_text) BETWEEN 1 AND 200),
  mention_count int NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
  sample_comment_ids uuid[] NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted', 'ignored')),
  topic_id uuid REFERENCES topic(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, canonical_key)
);

ALTER TABLE comment_inbox ADD COLUMN cluster_id uuid
  REFERENCES comment_question_cluster(id) ON DELETE SET NULL;

CREATE INDEX comment_inbox_canonical ON comment_inbox(account_id, canonical_key)
  WHERE deleted_at IS NULL AND category = 'question';
CREATE INDEX comment_cluster_open ON comment_question_cluster(workspace_id, status, mention_count DESC, last_seen_at DESC);
CREATE INDEX comment_cluster_account ON comment_question_cluster(account_id, status);

CREATE TABLE reader_term (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  window_start date NOT NULL,
  window_end date NOT NULL,
  term text NOT NULL CHECK (char_length(term) BETWEEN 2 AND 8),
  doc_freq int NOT NULL CHECK (doc_freq >= 1),
  sample_comment_ids uuid[] NOT NULL DEFAULT '{}',
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, window_start, window_end, term)
);
CREATE INDEX reader_term_window ON reader_term(account_id, window_start, window_end, doc_freq DESC);

-- +goose Down
DROP INDEX IF EXISTS reader_term_window;
DROP TABLE IF EXISTS reader_term;
DROP INDEX IF EXISTS comment_cluster_account;
DROP INDEX IF EXISTS comment_cluster_open;
DROP INDEX IF EXISTS comment_inbox_canonical;
ALTER TABLE comment_inbox DROP COLUMN IF EXISTS cluster_id;
DROP TABLE IF EXISTS comment_question_cluster;
ALTER TABLE comment_inbox DROP COLUMN IF EXISTS intent_confidence;
ALTER TABLE comment_inbox DROP COLUMN IF EXISTS canonical_key;
UPDATE topic SET source='manual' WHERE source='comment';
ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_source_check;
ALTER TABLE topic ADD CONSTRAINT topic_source_check
  CHECK (source IN ('manual', 'ai', 'review', 'hot', 'inbox', 'plan', 'daily'));
