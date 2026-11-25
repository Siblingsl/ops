# Plan: D-036 多租户工作区 + 邀请码协作

## Goal

把现有「单用户 / 单工作区」运行时升级为：开放注册自建工作区、一人多工作区切换、邀请码加入、owner/editor 权限，且租户数据（含模型密钥）按工作区隔离。生产已有账号须原地迁移可继续登录。

## Why a durable plan

触及 schema 迁移、会话身份、权限与公开 API，跨 `auth` / 设置 / 前端壳层；需要分批验收与明确退役路径，避免半套多租户上线。

## Plan basis（已批准）

- 决策：[D-036](../../90-决策与变更记录.md)
- 需求：`docs/04` FR-M1-01、06、08–11
- 流程：`docs/05` §6.1、P-01、P-24
- 数据与接口：`docs/06` §4.2–4.3、§5.9、§13.2「工作区与成员」
- 设计节：会话内已批准的 §1–§4

## Architecture

共享 PostgreSQL + 行级 `workspace_id` 隔离（方案 A）。

```text
app_user (登录) ──< workspace_member >── workspace
     │                      │
  session                   ├── workspace_invite
  (user_id +                ├── platform_account / 业务表…
   current_workspace_id)    └── model_provider / model_route / app_setting
```

实现表名：`app_user`（避免 PG 保留字 `user`）；文档与 API JSON 仍称「用户 / user」。T3 在 06 文档脚注对齐。

## Tech stack

既有：Go + pgx + goose、React/Vite、会话 Cookie、argon2id。不新增队列/邮件/SSO。

## Owners / files

| 区域 | 主要文件 |
| --- | --- |
| 迁移 | `server/internal/db/migrations/00001_init.sql`（仅空库基线）、**新增** `00002_multi_tenant.sql` |
| 身份 / 会话 | `server/internal/app/auth.go`、`httpx.go`（`identity`）、`server.go`（路由） |
| 工作区 / 邀请 | **新增** `server/internal/app/workspaces.go`（或拆 `invites.go`） |
| 模型租户化 | `server/internal/app/settings.go`、`jobs.go`（种子 provider） |
| CLI 重置 | `server/internal/app/auth.go`（`reset-password`）、`cmd/ops` |
| 回归 | `server/internal/app/hc_test.go`（保留 HC-01..10）+ 新隔离/权限测试 |
| 前端壳 | `web/src/App.tsx`、`pages/Login.tsx`、`pages/Setup.tsx`、Shell/顶栏组件 |
| 成员页 | **新增** `web/src/pages/settings/Members.tsx` |
| 模型/账号页 | `pages/settings/Models.tsx`、`Accounts.tsx`（editor 只读/隐藏写） |

## Compatibility boundary

- **保留**：Cookie 会话形态、CSRF、reauth、平台账号 CRUD、创作/推送主链路、HC-01..HC-10 不得删除或跳过。
- **兼容**：无用户时 `POST /auth/setup` 仍可用（与 register 等价）。
- **破坏性（有意）**：`member` 表退役；会话 identity 字段从 `MemberID` → `UserID`；`GET /auth/me` 增加 workspace/role；模型配置按工作区过滤（旧「全局一条」数据迁入原工作区）。
- **外部**：微信 IP 白名单、域名/反代不变。

## Change Necessity

仅改文档无法提供注册、隔离与邀请；必须改 schema + auth 中间件 + API + 前端切换器。最小边界：身份拆分与工作区上下文；业务表查询已多带 `workspace_id`，以扫漏与补模型表为主，不重写创作模块。

## Ripple notes

- **权威身份**：`identity`（`httpx.go`）为会话真相；所有 handler 经 `ident(ctx)`。
- **串租户风险**：`model_provider` / `model_route` / `app_setting` 今日无 `workspace_id`——T1 必须迁完。
- **退役**：代码与 SQL 不再引用 `member`；goose Down 可逆但生产以备份为准。

## TDD Route

- Mode: `off`（用户未要求 strict TDD）
- Decision: `skipped`（计划内用迁移后集成测试与权限/隔离用例做验收，不强制 RED/GREEN 步骤）
- Verification: `go test ./...`、前端 `typecheck`；手工双浏览器隔离烟测

## Requirement Ready Check

- Source: D-036 + 04/05/06 已更新 → **ready**
- Acceptance: 见下方 Verification；分期 T1/T2/T3

## Intent Lock

实现 D-036 批准规则；不引入邮箱、计费、viewer、解散工作区、微信第三方平台。

## Scope Fence

- In: 迁移、注册、工作区切换、邀请码、owner/editor、模型/设置租户化、P-24、文档脚注、HC 扩展
- Out: 计费、邮件、viewer、SSO、按账号 ACL、解散租户、改部署拓扑

## Baseline Lock

以 D-036 与 `docs/06` §13.2 工作区接口为准；若实现需改路径，先改文档再改代码。

---

## Tasks

### Task 1 — Schema 迁移 `00002_multi_tenant`（T1）

**Purpose:** 空库与已部署库都能从 `member` 变为 `app_user` + `workspace_member`。

**Files:** `server/internal/db/migrations/00002_multi_tenant.sql`

**Steps:**
1. 建 `app_user`（字段从 `member` 迁：username/password/锁定/登录痕迹；去掉 workspace_id/role）。
2. `workspace` 增加 `created_by_user_id`（可空后回填）。
3. 建 `workspace_member(workspace_id, user_id, role, status)`，唯一约束。
4. 数据：每个 `member` → 一行 `app_user`（**保留原 UUID 作为 user id**，降低 audit/session 改写成本）+ 一行 `workspace_member(owner, active)`。
5. `session`：`member_id` → `user_id`；新增 `current_workspace_id`（回填为原 member 的 workspace）。
6. 建 `workspace_invite`（结构见 06）。
7. `model_provider` / `model_route` / `app_setting` 加 `workspace_id`：用「库中唯一/第一条 workspace」回填；`model_route` 主键改为 `(workspace_id, task_type)`；`app_setting` 主键改为 `(workspace_id, key)`。
8. Drop `member`（在 FK 全部切走后）。
9. Down：尽可能逆操作（测空库 up/down）；生产部署前备份 volume。

**Verify:** 本地/CI 对空库 `goose up`；对拷贝了生产结构的库跑迁移后 `SELECT` 校验 user/member/session 行数一致。

**Commit message hint:** `DEV-M01: multi-tenant schema migration`

---

### Task 2 — 身份上下文与 auth API（T1）

**Purpose:** 登录/注册/会话解析以 user + current workspace 工作。

**Files:** `httpx.go`、`auth.go`、`server.go`；必要时小测文件

**Changes:**
- `identity`：`UserID`、`WorkspaceID`、`Role`、`Username`、`SessionID`、`ReauthOK`（删除 `MemberID` 或别名过渡一期后删光）。
- `loadSession`：join `app_user` + `workspace_member`（当前工作区须 active）；校验成员关系。
- `POST /auth/register`：建 user + workspace + owner 成员 + session；种子敏感词（复用 setup 逻辑）。
- `POST /auth/setup`：若已有任意 user → 409；否则同 register。
- `POST /auth/login`：按 username；`current_workspace_id` = 最近会话工作区或唯一成员工作区。
- `GET /auth/me`：返回 user、workspaces 摘要或 current `{id,name,role}`、csrf。
- `ops reset-password <username>`：更新 `app_user`，删该用户 sessions。
- audit `actor_id` 记 `user_id`。

**Verify:** 单元/集成：register → me；setup 仅空库；旧迁移用户能 login。

---

### Task 3 — 工作区列表/创建/切换 + 模型查询加租户过滤（T1）

**Purpose:** 多工作区可切换；模型密钥不串租户。

**Files:** 新 `workspaces.go`；`settings.go`；`jobs.go`；`server.go` 路由

**API（T1 最小集）:**
- `GET /workspaces`
- `POST /workspaces`
- `POST /workspaces/{id}/switch`
- `PATCH /workspaces/{id}`（改名，owner——可放到 T2，若 T1 只读列表+切换也可）

**Settings:** 所有 `model_provider` / `model_route` / `app_setting` SQL 带 `workspace_id = ident.WorkspaceID`；新建 provider 写入当前工作区。

**Verify:**
- 用户 A/B 各注册 → A 的 provider 对 B 的 list 不可见（集成测试）。
- 切换工作区后 `me.workspace.id` 变化，账号列表随之变。

**T1 出口验收:** 生产迁移后原用户可登录；第二用户注册建独立工作区；跨租户读账号/模型失败（404/空列表）。

---

### Task 4 — 邀请码与成员管理 API（T2）

**Purpose:** FR-M1-06/11。

**Files:** `workspaces.go`（或 `invites.go`）

**API:** 实现 06 §13.2 全部成员/邀请路径：`members`、`leave`、`invites` CRUD/revoke、`POST /workspaces/join`。

**规则:** 码 8 位易读；默认 editor、7 天、max_uses=10；唯一 owner 保护；重复加入不耗次数。

**Verify:** 集成测试覆盖生成→加入→切换→撤销→过期/用尽。

---

### Task 5 — owner/editor 权限闸（T2）

**Purpose:** 落实 D-036 矩阵。

**Files:** `httpx.go`（`requireOwner`）、`accounts.go`（凭证写）、`settings.go`（模型写）、成员写接口

**Rules:** editor 可创作/推送；不可写凭证/模型/邀请/改角色；读模型列表可返回脱敏或 403 整页——与前端一致选「设置页对 editor 隐藏写入口，API 仍 403」。

**Verify:** editor token 调 `PUT wechat-credential` / `POST model_provider` / `POST invites` → 403；owner → 200。

---

### Task 6 — 前端：注册、工作区切换、成员页（T2）

**Purpose:** P-01 / P-24 / 顶栏切换。

**Files:** `Login.tsx`、新 `Register.tsx`（或同页 Tab）、`App.tsx`、`Setup.tsx`、Shell/顶栏、新 `settings/Members.tsx`、`Models.tsx`/`Accounts.tsx` 按 role 隐藏写、API client 类型

**UX:**
- 注册页；登录页「我有邀请码」可选字段（登录/注册后 `join`）。
- 顶栏工作区切换 → `switch` → `queryClient.clear()`。
- 设置「成员与邀请」：owner 管理；editor 可见成员只读 + 离开 + 加入其他工作区。

**Verify:** `pnpm typecheck`；本地双用户手测邀请与切换。

**T2 出口验收:** 邀请加入、角色权限、切换工作区全链路可用。

---

### Task 7 — HC 扩展、扫尾、文档脚注（T3）

**Purpose:** 防回归与文档一致。

**Files:** `hc_test.go` 或 `tenant_test.go`；`docs/06` 表名脚注 `app_user`；`docs/08` 增 DEV 任务行（可选）；确认 AGENTS 红线仍含 HC-01..10

**New tests (建议编号):**
- HC-11：跨工作区 ID 访问作品/账号 → 404
- HC-12：editor 不能改模型密钥
- （可选）HC-13：邀请码用尽后失败

**Verify:** `go test ./...`；CI 绿；生产备份后部署迁移 + smoke。

**T3 出口:** D-036 实现关闭；本版不做项仍不做。

---

## Verification（总）

| 阶段 | 命令 / 证据 |
| --- | --- |
| 每 Task | 相关 `go test` / typecheck |
| T1 | 双用户隔离 + 迁移用户登录 |
| T2 | 邀请码 + editor 403 + UI 切换 |
| T3 | HC-01..10 全绿 + 新隔离用例；Deploy workflow 成功 |
| 生产 | 部署前 `pg_dump` 或 volume 快照；部署后原 `skyeder` 可登录 |

## Risks

| 风险 | 缓解 |
| --- | --- |
| 迁移弄丢会话/密码哈希 | 保留 user UUID；迁移脚本先在 staging/本地拷贝验证 |
| SQL 漏 `workspace_id` | T1/T3 隔离测试；code review 扫 `FROM model_` |
| `user` 保留字 | 表名 `app_user` |
| 前端缓存串工作区 | switch 后 `queryClient.clear()` |

## Retirement

| 旧路径 | 动作 |
| --- | --- |
| 表 `member` | Task 1 drop |
| `identity.MemberID` / SQL `FROM member` | Task 2 清零 |
| 「全站仅 setup 一次」产品假设 | 由 register 取代；setup 仅空库兼容 |
| 全局 `model_provider` | 迁入工作区后禁止无 workspace 查询 |

## Execution route

- **Decision:** `inline`（`aegis:executing-plans`）
- **Evidence:** 任务强串行（迁移 → auth → API → UI）；并行收益低
- **Fallback:** 若 T2 前端与 T2 API 可分人，再考虑 subagent；默认仍 inline
- **User confirmation required:** **yes — 生产库迁移前确认已备份**（执行到生产部署时再问；本地开发可直接开 Task 1）

## Self-review

- 覆盖 D-036 §1–§4 与 FR-M1-09..11
- 无邮箱/计费/viewer 范围漂移
- HC-01..10 明确保留
- 表名 `app_user` 与文档 `user` 在 T3 对齐
- 无 TBD 占位任务
