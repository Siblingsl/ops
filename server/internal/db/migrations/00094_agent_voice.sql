-- +goose Up
-- DEV-AI27-16（W16）：双模式语音会话与回合（27 文档 §11.4 提案契约本机实现批）。
-- 语音输入（dictation）：录音→转写→可编辑终稿→用户发送；临时转写不发送不作为指令。
-- 实时语音（realtime）：双向说话/字幕/进度→可打断/静音/切文字→结束；
--   同一最终 turn 只产生一条持久消息和一次原 run 受理（去重）。
-- 音频不落盘（默认）；转写文本按消息隐私/脱敏处理；语音不构成确认（红线）。

CREATE TABLE agent_voice_session (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    mode varchar(12) NOT NULL CHECK (mode IN ('dictation','realtime')),
    state varchar(16) NOT NULL DEFAULT 'active',
    route_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    CONSTRAINT agent_voice_session_state CHECK (
        state IN ('active','ending','ended','error'))
);
CREATE INDEX idx_agent_voice_session_conversation ON agent_voice_session(conversation_id, state);
-- 一设备只开一个活动麦克风会话（27 §11.4.3）。
CREATE UNIQUE INDEX uq_agent_voice_session_active ON agent_voice_session(user_id)
    WHERE state = 'active';

CREATE TABLE agent_voice_turn (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES agent_voice_session(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    turn_index integer NOT NULL,
    purpose varchar(20) NOT NULL CHECK (purpose IN ('transcribe','commit_realtime')),
    state varchar(16) NOT NULL DEFAULT 'recording',
    transcription text NOT NULL DEFAULT '',
    final_message_id uuid,
    run_id uuid,
    playback_position_ms integer NOT NULL DEFAULT 0,
    duration_ms integer NOT NULL DEFAULT 0,
    request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_voice_turn_state CHECK (
        state IN ('recording','transcribing','reviewable','submitted','error','interrupted')),
    CONSTRAINT uq_agent_voice_turn_request UNIQUE (session_id, request_id)
);
CREATE INDEX idx_agent_voice_turn_session ON agent_voice_turn(session_id, turn_index);

-- +goose Down
DELETE FROM agent_voice_turn;
DELETE FROM agent_voice_session;
DROP TABLE IF EXISTS agent_voice_turn;
DROP TABLE IF EXISTS agent_voice_session;
