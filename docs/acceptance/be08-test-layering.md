# BE-08 测试分层与 CI 耗时评估

> 依据：`docs/33` §11.7 / §11.8 BE-08。**只评估，不改 CI 断言，不跳过任何用例。**
> 实测机：Windows 本机 + Docker Compose PostgreSQL（`:5440`）；日期 2026-11-11。
> CI 现状：`.github/workflows/ci.yml` server job → `go test -p 1 ./...`（注释：OPT-02 p95 在包并行下不稳定）。

## 1. 三层划分（建议本地用；CI 仍跑全量）

| 层 | 目的 | 命令 | 覆盖边界 | 本机实测 wall |
|---|---|---|---|---|
| **L1 快速单测** | 改小包后秒级反馈 | `cd server && go test ./internal/ai ./internal/config ./internal/crawl ./internal/cxbuildvalidate ./internal/cxcanonicaljson ./internal/cxrendercontract ./internal/markdownsyntax ./internal/mock ./internal/secure ./cmd/ops -count=1` | 不含 DB 迁移、文档解析容器、app 业务/HC | **~5–10s**（`-p 1` 约 5s；默认并行约 10s，受缓存影响） |
| **L2 集成子集** | 改 app 后核对红线与相关契约 | `cd server && go test ./internal/app -run 'TestHC\|TestBE0\|TestW15\|TestW06\|TestA13\|TestPublish' -count=1` | HC-01~31 + 本波次 BE + 委派/发布代表；**不含**全量 CX/OPT/主链 | **~27s**（仅 `TestHC`）/ **~35s**（含 BE/W/A13/Publish；BE-01 两条设计内常红会令 EXIT≠0） |
| **L3 全量回归** | 任务包验收与 CI | `cd server && go test -p 1 ./... -count=1`（与 CI 同形） | 全部包与全部用例；不得 `t.Skip`/`-short`/build tag 藏断言 | **~9–10 min** 本机；三大头见下 |

> **硬约束**：任务包验收与合并前仍按 `docs/33` §7.3 跑 **L3 全量**。L1/L2 只加速开发反馈，不能替代 L3。

## 2. 全量包耗时基线（可复算）

命令：`cd server && go test ./... -count=1`（B1 批末同机，2026-11-11）。

| 包 | 耗时 | 备注 |
|---|---|---|
| `ops/internal/app` | **481–496s** | 最大头；含 OPT02 性能门槛与 BE-01 常红 |
| `ops/internal/db` | **~149s** | 迁移/隔离 |
| `ops/internal/documentparse` | **~159s** | 依赖解析 worker socket |
| `ops/internal/ai` | ~1.0s | |
| 其余小包合计 | <2s | config/crawl/cx*/markdownsyntax/mock/secure/cmd |
| 无测试 | — | `ops/cmd/ops-e2e`、`ops/internal/wechat` |

墙钟合计约 **540s**（包并行默认）；CI 用 `-p 1` 时墙钟 ≈ 各包串行相加（约 7–9+ min，视 runner）。

## 3. `-p` 并行与缓存收益评估

| 选项 | 结论 | 证据 |
|---|---|---|
| CI 保持 `-p 1` | **建议维持** | OPT-02 在包并行下 p95 抖动已多次登记（CI 注释 + docs/08 OPT 历史）；改 `-p` 会引入假红，需另立「性能用例基准环境」任务 |
| 本地 L1 用默认并行 | 可接受 | 小包几乎无共享状态；收益有限（秒级） |
| 本地 L3 用默认并行 | 可用作快扫 | 若仅 BE-01 常红 + 偶发 OPT02，单项复跑即可；**验收口径仍以 `-p 1` 或「仅设计内红」为准** |
| Go 测试缓存 | `-count=1` 禁用缓存 | 评估与验收一律 `-count=1`；日常编辑可用默认缓存加速 L1 |

**不建议**引入：按 build tag 拆「快/慢」测试二进制、在 CI 用 `-short`、把 OPT02/HC 挪出全量。均触碰红线 5。

## 4. 与前端分层的关系（只登记，不改 CI）

| 端 | 快速 | 全量（CI 已有） |
|---|---|---|
| web | `pnpm typecheck && pnpm test:unit`（本机 ~52 例） | `pnpm test:e2e` |
| renderer | `pnpm typecheck && pnpm test:unit`（~46） | desktop `pnpm test:e2e:renderer` |
| desktop | `pnpm test`（~367） | 同上 + 安装包烟测（未验证项） |

后端 L1/L2 与前端 unit 可并行；**后端 L3 与双端 E2E 同机并行会抬高 OPT02 退化率**（B1 批末实证）。

## 5. 获批后方可改 CI 的候选项（本任务不实施）

1. 保留 `go test -p 1 ./...` 不变。
2. 可选：在 server job 增加 **非门禁** 的 L1 预检 step（失败不 fail job）——收益低，暂不推荐。
3. OPT02 独立 job / 固定种子数据规模——需新任务 + 拍板，不在 BE-08。

## 6. 复算命令清单

```powershell
cd F:\code\project\OPS\server
# L1
go test ./internal/ai ./internal/config ./internal/crawl ./internal/cxbuildvalidate ./internal/cxcanonicaljson ./internal/cxrendercontract ./internal/markdownsyntax ./internal/mock ./internal/secure ./cmd/ops -count=1
# L2 HC
go test ./internal/app -run 'TestHC' -count=1
# L3（与 CI 同形）
go test -p 1 ./... -count=1
```
