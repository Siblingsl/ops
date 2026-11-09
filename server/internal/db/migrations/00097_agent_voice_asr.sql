-- +goose Up
-- DEV-AI27-16（W16）：真实 ASR 转写与时长记账（27 §11.4.3 / V05 / V07）。
-- 只记录供应商回执的模型名与音频时长；音频本身仍不落盘（§11.4.3）。
-- 失败原因单独成列，避免把「供应商不可用」伪装成「空转写」。
ALTER TABLE agent_voice_turn
    ADD COLUMN asr_provider text NOT NULL DEFAULT '',
    ADD COLUMN asr_model text NOT NULL DEFAULT '',
    ADD COLUMN asr_seconds double precision NOT NULL DEFAULT 0,
    ADD COLUMN asr_error_code text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE agent_voice_turn
    DROP COLUMN IF EXISTS asr_provider,
    DROP COLUMN IF EXISTS asr_model,
    DROP COLUMN IF EXISTS asr_seconds,
    DROP COLUMN IF EXISTS asr_error_code;
