# BE-09 `internal/app` 单包拆分评估

> 依据：`docs/33` §11.1 / §11.8 BE-09；≡ DEV-S06。**只评估，不移动任何文件。**
> 决策登记：`docs/90` **D-176**（待拍板后方可实施）。
> 实测日期：2026-11-11。口径：排除 `*_test.go` 的生产文件，除非另注。

## 1. 现状基线【实测】

| 项 | 本轮实测 | docs/33 v2.0 登记 |
|---|---|---|
| 生产文件 / 行 | **236 / 96240** | 235 / 100346（行数口径含空行差异，数量级一致） |
| 测试文件 / 行 | **268 / 59193** | 262 / 62106 |
| 路由 `r.Get/Post/Put/Delete/Patch(` | **585** | 585 |
| 迁移 `.sql` | **102**（均在 `server/internal/db/migrations`） | 102 |
| `go list -deps ./internal/app` 的 `ops/` 依赖 | `ai` `config` `crawl` `cxbuildvalidate` `cxcanonicaljson` `cxrendercontract` `documentparse` `markdownsyntax` `secure` `wechat` | 与 11.1 一致：小包已在外，巨型逻辑仍在 `app` |

**文件名前缀聚类（启发式，非边界裁决）**：`agent_*` 66、`cx_*` 29、platform/wechat/xhs/toutiao 16、skill 8、publish/push 6、其余 111（含 server/auth/works/materials/…）。

**已有可下传接口【实证】**：

- `skills.go:189` `skillQuerier`（`Query`/`QueryRow`）——技能解析可在事务/非 Server 上跑
- `cx_visual_plan_http.go:59` `cxVisualPlanQueryer` —— 同上模式
- `material_basis.go` `materialBasisQuerier`、`topics.go` `topicFieldQuerier`

这些接口证明「读路径可抽接口」已有先例；**写路径与 HTTP 装配仍绑在 `*Server`**。

## 2. 拟议包边界（实施前须批准）

方向：**依赖单向** —— `cmd/ops` → `app`（HTTP 装配）→ 领域子包 → `db`/`ai`/`wechat`/…；**禁止**领域子包反向 import `app`。

| 拟议包 | 大致迁入 | 依赖允许 | 不迁入 |
|---|---|---|---|
| `internal/app`（瘦壳） | `server.go` 路由装配、中间件、`ident`/`audit`/`observe`、跨域编排 | 可依赖所有子包 | 厚业务 |
| `internal/agent` | `agent_*.go`、委派/记忆/工具目录 | `db` 经由 querier；不碰 publish/cx | UI 路由注册 |
| `internal/cx` | `cx_*.go`、写作依据相关 | `cxbuildvalidate`/`cxcanonicaljson`/`cxrendercontract` | 微信推送 |
| `internal/publish` | `publish*.go`、push 状态机 | `wechat`、`secure` | agent 循环 |
| `internal/skills` | `skills*.go` | 已有 `skillQuerier` | — |
| `internal/platform` | platform sync / 账号凭证 | `wechat` 等 | — |

> 「其余 111」多数是作品/素材/鉴权/设置——**第一期不拆**，避免一次搬迁炸掉测试与 HC-28。

## 3. 循环依赖与迁移约束

- **循环风险**：`agent` ↔ `cx`（上下文注入）、`publish` ↔ `works` 状态。缓解：共享类型放 `internal/appdomain`（或现有小包），或通过接口（仿 `skillQuerier`）下传，**禁止**为破环引入 `import cycle` 适配器包膨胀。
- **迁移单一源**：继续唯一目录 `server/internal/db/migrations`；子包**不得**自带 goose 迁移。拆包不改表归属。
- **测试**：`TestMain`/共享 `env` 夹具今日绑在 `package app`。拆包后要么（A）测试仍留 `app` 黑盒测 HTTP，要么（B）每子包自建轻量 env——推荐 **A 为主、B 仅纯函数包**。

## 4. 分阶段搬迁顺序与每阶段回归

| 阶段 | 动作 | 回归清单 | 预估打断面 |
|---|---|---|---|
| 0 | 本评估 + D-176 拍板 | 无代码 | — |
| 1 | 抽 `internal/skills`（已有 querier，耦合最低） | `TestSkill*`、`TestHC28`、`go test ./internal/app -run 'TestSK\|TestSkill'`、L3 全量 | 技能路由 import 路径；HC-28 清单路径字符串不变 |
| 2 | 抽 `internal/cx`（只读/校验面已有小包） | `TestCX*`、`TestHC`、documentparse 联调 | cx HTTP 注册仍在 app |
| 3 | 抽 `internal/publish` | `TestPublish`、`TestBE06`、主链推送段 | `pushWechat` 与 work 状态交叉 |
| 4 | 抽 `internal/agent`（最大） | `TestW*`/`TestA13`/`TestBE01`/`TestHC26-31`、HC-28 工具目录 | 工具 Path 与 `agentCatalog` 同源；**最易炸** |
| 5 | 瘦壳收尾 + 文档/CI 路径 | L3 + 双端契约冒烟 | `go list`、IDE 跳转 |

每阶段：**一次提交只搬一个包**；失败则按包 `git revert`（L1）。不与 BE-01 迁移拍板并行（避免迁移+拆包双冲突）。

## 5. HC-28 与 CI 影响

- **HC-28**（`agent_catalog_test.go`）：工具目录与「路由已归类」清单依赖 `env.srv.Router()` 与 `agentCatalog()`。拆包后：
  - 路由仍须由瘦壳 `buildRouter` 注册（路径字符串不变 → HC-28 **可保持绿**）。
  - `agentCatalog()` 若迁到 `internal/agent`，测试 import 与包名变更；**静态检查逻辑不得放宽**。
- **CI**：`.github/workflows/ci.yml` 的 `go test -p 1 ./...` 自动覆盖新包；**无需为拆包改断言**。新增包若引入测试，耗时计入 L3（见 BE-08）。
- **会打断的测试**：所有 `package app` 内对未导出符号的白盒测试；跨文件未导出 helper。搬迁清单须先 `go test` 按阶段列未导出依赖。

## 6. 取舍与建议

| 选项 | 说明 | 建议 |
|---|---|---|
| A. 按上表分 5 阶段实施 | 长期可维护，短期高冲突成本 | **拍板后执行**；先 skills |
| B. 只抽接口、不搬文件 | 继续在 `app` 内用 querier 下传 | 若近期仍有 BE/DT 在途，可作过渡 |
| C. 一次性大搬迁 | 禁止（与「一次一个任务包」冲突） | 否决 |

**本任务交付**：本评估 + D-176 登记；**零文件移动**。

## 7. 复算命令

```powershell
cd F:\code\project\OPS\server
# 生产/测试规模
Get-ChildItem internal/app -Filter *.go | Where-Object { $_.Name -notmatch '_test' } | Measure-Object
go list -deps ./internal/app | Select-String '^ops/'
# 路由
(Select-String -Path internal/app/*.go -Pattern 'r\.(Get|Post|Put|Delete|Patch)\(' | Where-Object { $_.Path -notmatch '_test' }).Count
```
