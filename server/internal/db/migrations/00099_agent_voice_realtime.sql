-- +goose Up
-- DEV-AI27-16 第六批（A2，27 §11.4.5 / V08）：realtime 双向音频记账。
-- 音频本身不落盘（§11.4.3）；只记录供应商回执的模型名、双向音频时长与失败原因。
ALTER TABLE agent_voice_turn
    ADD COLUMN realtime_provider text NOT NULL DEFAULT '',
    ADD COLUMN realtime_audio_ms integer NOT NULL DEFAULT 0,
    ADD COLUMN realtime_error_code text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE agent_voice_turn
    DROP COLUMN IF EXISTS realtime_provider,
    DROP COLUMN IF EXISTS realtime_audio_ms,
    DROP COLUMN IF EXISTS realtime_error_code;
