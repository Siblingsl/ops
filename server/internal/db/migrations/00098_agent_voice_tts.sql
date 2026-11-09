-- +goose Up
-- DEV-AI27-16 第五批（A1，27 §11.4.4 / V07）：TTS 合成记账。
-- 只记录供应商回执的模型名与合成字符量；音频本身不落盘（§11.4.3 同口径）。
-- 失败原因单独成列，不把「供应商不可用」伪装成「空音频」。
ALTER TABLE agent_voice_turn
    ADD COLUMN tts_provider text NOT NULL DEFAULT '',
    ADD COLUMN tts_model text NOT NULL DEFAULT '',
    ADD COLUMN tts_characters integer NOT NULL DEFAULT 0,
    ADD COLUMN tts_error_code text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE agent_voice_turn
    DROP COLUMN IF EXISTS tts_provider,
    DROP COLUMN IF EXISTS tts_model,
    DROP COLUMN IF EXISTS tts_characters,
    DROP COLUMN IF EXISTS tts_error_code;
