-- 适配器版本级熔断（20 文档 §12：platform_schema_changed 默认对该 adapter_version+platform
-- 全局熔断，不只停单连接；恢复必须发布新 mapping_version 并重新实测）。
--
-- 为什么单独成表而不是放 system_setting：熔断按 (platform, adapter_version) 组合记录，
-- 需要保留触发时的证据（错误码、时间、受影响连接数）用于"为什么昨天有今天没有"的解释，
-- 且同一平台可能有多个适配器版本并存（旧客户端仍在跑旧版本）。

-- +goose Up
CREATE TABLE platform_adapter_breaker (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform         text NOT NULL CHECK (platform IN ('xhs', 'wechat_mp', 'toutiao')),
    adapter_version  text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 64),
    -- 触发熔断的错误码，首版只有 platform_schema_changed 会写入。
    error_code       text NOT NULL CHECK (length(error_code) BETWEEN 1 AND 64),
    mapping_version  integer,
    -- open 表示该版本全部任务被拒；resolved 表示已发布新版本并重新实测。
    state            text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
    opened_at        timestamptz NOT NULL DEFAULT now(),
    resolved_at      timestamptz,
    -- 触发时受影响的连接数，用于运营诊断；不随连接增减更新。
    affected_connections integer NOT NULL DEFAULT 0 CHECK (affected_connections >= 0),
    note             text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 同一平台的同一适配器版本同时只允许一条 open 熔断。
CREATE UNIQUE INDEX platform_adapter_breaker_open_uniq
    ON platform_adapter_breaker (platform, adapter_version)
    WHERE state = 'open';

CREATE INDEX platform_adapter_breaker_platform_idx
    ON platform_adapter_breaker (platform, opened_at DESC);

-- +goose Down
DROP TABLE IF EXISTS platform_adapter_breaker;
