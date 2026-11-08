-- +goose Up
-- DEV-AI27-09（W09）：浏览器证据与页面批注（27 文档 §13.2/§10.1 提案契约本机实现批）。
-- 证据：本机观察后上报的脱敏摘要（origin/脱敏 URL/标题/片段/文档版本/内容哈希）；
-- 未读页面不得生成"已核实"；密钥命中隔离（redaction_state）。
-- 批注：用户选区/区域 → 引用筹码（不自动发送、不自动修改页面/业务对象）。

CREATE TABLE agent_browser_evidence (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    run_id uuid,
    command_id uuid,
    origin varchar(256) NOT NULL,
    redacted_url varchar(512) NOT NULL DEFAULT '',
    title varchar(256) NOT NULL DEFAULT '',
    snippet text NOT NULL DEFAULT '',
    doc_revision varchar(64) NOT NULL DEFAULT '',
    kind varchar(16) NOT NULL DEFAULT 'text',
    content_hash varchar(64) NOT NULL,
    redaction_state varchar(16) NOT NULL DEFAULT 'clean',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_browser_evidence_kind CHECK (kind IN ('text','screenshot','annotation')),
    CONSTRAINT agent_browser_evidence_redaction CHECK (redaction_state IN ('clean','quarantined'))
);
CREATE INDEX idx_agent_browser_evidence_conversation ON agent_browser_evidence(conversation_id, created_at);
CREATE INDEX idx_agent_browser_evidence_run ON agent_browser_evidence(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE agent_browser_annotation (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    evidence_id uuid REFERENCES agent_browser_evidence(id) ON DELETE SET NULL,
    origin varchar(256) NOT NULL DEFAULT '',
    doc_revision varchar(64) NOT NULL DEFAULT '',
    selection_text text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_browser_annotation_conversation ON agent_browser_annotation(conversation_id, created_at);

-- +goose Down
DELETE FROM agent_browser_annotation;
DELETE FROM agent_browser_evidence;
DROP TABLE IF EXISTS agent_browser_annotation;
DROP TABLE IF EXISTS agent_browser_evidence;
