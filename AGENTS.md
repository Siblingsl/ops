# AGENTS.md

本仓库是"公众号 + 小红书 AI 辅助运营平台"（D-036 起：多租户工作区 + 邀请码协作；历史 MVP 为单用户）。设计文档在 `docs/`，开发前先读任务对应的文档条目。

## 核心

- 不熟悉的功能别从零写，先去 GitHub 搜同类开源项目、对比思路再动手

## 先读文档再写代码

- 功能与验收标准：`docs/04-需求与功能分级.md`
- 页面与交互、异常处理：`docs/05-业务流程与交互.md`
- 数据表、模块、AI 任务契约、接口清单：`docs/06-数据与技术架构.md`
- 任务拆分与测试：`docs/08-开发与测试计划.md`
- 决策记录：`docs/90-决策与变更记录.md`（实现与设计不一致时，先查证差异、记录问题与拟议变更；涉及需求或架构决策时不得仅靠登记就视为获准修改）
- 系统智能体（DEV-AG 任务）：`docs/16-系统智能体设计.md`（D-117）
- 账号类型迁移与创作模板（DEV-415/416）：`docs/18-账号类型迁移与创作模板设计.md`（D-123/D-124）
- 操作动线问题：`docs/22-操作动线问题清单.md`（所有动线问题统一追加在这里；改动前先查对应条目）
- 技能系统（DEV-SK 任务）：`docs/23-技能系统设计.md`（D-151）
  - DEV-SK 必须遵循 23 文档 v0.3 及后续登记版本的接口、权限、状态与验收契约；需要偏离时先更新 23 与 D-151。设计基线不表示功能已实现，按对应任务同步 04/05/06/08/16 的实施记录。
- 依赖安全整改（Dependabot 告警、升级批次、验收与回滚口径）：`docs/28-依赖安全整改清单.md`
- 内容生产流水线与运营方法（DEV-CX 任务）：`docs/24-内容生产流水线与运营方法增强设计.md`（D-156）
  - 24 文档是排版产物、社交组图、内容诊断与运营台账的唯一规格；实施状态按 DEV-CX01–14 在 08 记录。设计已登记不等于已实现。

## 目录

```
server/                Go 后端（cmd/ops 为入口；internal/ 为业务模块）
renderer/              **唯一前端**：React + TypeScript + Vite 桌面业务界面
  App.tsx main.tsx     渲染入口；界面源码直接放在包根，没有 src/ 一层
  components/ layout/ lib/ pages/ styles/
  e2e/                 桌面形态 Playwright 用例（含 Electron 真实窗口）
  tests/               桌面渲染器单测与边界守卫
shared/                前后端共享源码（types/api/format/skills/AI 错误等）；严禁删除
  renderer/lib/* 与 tools/office-render 依赖它
desktop/               Electron 桌面端
  src/                 Electron 主进程与本机客户端能力
  renderer/            桌面安装包使用的构建产物（由 renderer/ 构建生成）
tools/office-render/   Office 模板渲染工具（依赖 shared/office-templates.json）
deploy/                Docker Compose 与部署配置
docs/                  设计文档
```

`renderer/` 是唯一前端：入口、依赖锁文件、构建配置、界面源码与 E2E 用例全部在这里。原独立的 `web/` 已按 D-224 物理删除，只读存档标签为 `archive/web-before-removal`（可随时回看/恢复），规格见 `docs/43-桌面端主攻与全局优化实施方案.md`。`desktop/renderer/` 是生成目录，不直接编辑。

**严禁删除 `shared/` 目录**：`renderer/lib/*`（`types.ts`、`api.ts`、`format.ts`、`skills.ts` 等数十个文件）全部 `export * from '../../shared/...'`，`tools/office-render/build-templates.mjs` 也依赖 `shared/office-templates.json`。它不是可清理的历史目录。

`renderer/` 位于仓库根、与 `desktop/` 平级，不再嵌在 `desktop/` 内：这样渲染源码的路径深度从 6 层降到 5 层，且依赖与构建产物不再混进 Electron 打包目录。它对 `desktop/` 的引用一律走 `../desktop/...`（主进程产物在 `desktop/.build/`），不反向读取 `desktop/src/` 源码。

E2E 只有桌面一套，用例在 `renderer/e2e/`：

```powershell
cd desktop; pnpm test:e2e:renderer  # 5287 / 8287 / 8297
```

本机若设置了 `HTTP_PROXY` 而 `NO_PROXY` 未包含回环地址，Playwright 的 webServer 健康检查会被代理接管并一直超时（日志表现为服务已启动但持续 404）。配置已显式 `NO_PROXY=127.0.0.1,localhost,::1`；手工启动服务时也需自行排除。

`renderer/e2e/` 不允许引用已废弃的 `web/` 路径与 Web 端口（5179 / 8180 / 8191），不允许相对路径越出仓库根，也不允许写仓库根 `output/` 根层。这些约束由 `renderer/tests/e2e-boundary.test.mjs` 在 `test:unit` 中强制。

截图与报告统一落在仓库根 `.playwright-results/`（CI 按该路径上传），桌面产物在 `desktop-renderer/` 与 `desktop-renderer-report/`；`web/`、`web-report/` 是原 Web 端的历史产物，`web/` 删除后不再生成，仅保留用于回看旧证据。桌面 runner 的 `process.cwd()` 是仓库根 `renderer/`，所以桌面用例写产物用 `../.playwright-results/` 和 `../output/`；写 `../../` 会越出仓库根，桌面边界测试会拦截。桌面级依赖（Electron 可执行文件、主进程产物 `desktop/.build/`）必须写 `../desktop/...` 前缀，写成 `../node_modules`、`../.build` 会指向不存在的仓库根路径。

仓库根 `output/` 现在只由桌面写入，桌面只能写 `output/playwright/`；根层文件（如 `output/toutiao-*.png`）是原 Web 端的历史产物，不再回填。桌面边界测试会拦截"桌面写 `output/` 根层"。

`server/` 是**唯一后端**：`server/cmd/ops-e2e` 为桌面 E2E 提供 API 与模拟模型，差异只由 `OPS_AGENT_WORKBENCH_FEATURES` 等环境变量控制。不要把它复制成多份，也不要在 `renderer/` 里另起一套服务端逻辑。

## 本地开发

```powershell
docker compose -f deploy/docker-compose.dev.yml up -d   # PostgreSQL，端口 5440
cd server; go run ./cmd/ops serve                       # API :8080，模拟微信与模拟模型 :8091
cd renderer; pnpm install; pnpm dev                     # 唯一前端开发服务器 :5173，代理 /api 到 :8080
```

桌面端开发与构建：

```powershell
cd desktop; pnpm install --frozen-lockfile
pnpm --dir ../renderer install --frozen-lockfile
pnpm build:renderer
pnpm start
```

本地默认使用模拟微信服务器和模拟模型（`OPS_DEV=1`），不需要任何真实密钥。

要联调桌面端自动采集，API 必须显式开启平台开关，否则客户端会跳过 presence 心跳，调度永远不派单且**没有任何报错**：

```powershell
cd server; $env:OPS_DESKTOP_PLATFORM_ENABLED='1'; go run ./cmd/ops serve
```

该开关只在进程启动时读取，改了必须重启 API。自动采用闸门是另一个变量 `OPS_DESKTOP_PLATFORM_AUTO_ADOPT`，默认关闭，验收通过前不要打开。详见 `docs/21-平台采集技术债处理记录.md` 十七点四十四第 1 节。

## 不可越过的红线

- 不添加"全部起草""全部确认""全部入库"之类的按钮或接口；智能体不添加"全部执行"或批量执行卡片的按钮或接口，写入只能由用户逐张执行（D-117）；
- 不在代码、日志、测试数据中写入真实密钥；
- 不删除或跳过 HC-01 至 HC-25 测试（`server/internal/app/hc_test.go`）；DEV-AG 任务加入的 HC-26 至 HC-31 同样适用。
- **严禁删除 `shared/` 目录**（`renderer/lib/*` 与 `tools/office-render` 依赖它）；同样严禁删除 `docs/42-evidence/` 与 `server/internal/app/wechat_drafts*.go` 等已登记的真实闭环成果。
- 原独立 `web/` 已按 D-224 物理删除，只读存档在标签 `archive/web-before-removal`；不得重新引入第二套浏览器前端，也不得把存档"恢复一半"混进工作树。

## 任务识别、事实来源与状态核验

- 开始任务时先确认任务编号、目标、验收标准、影响范围，以及当前 Git 工作树是否存在他人或此前遗留的未提交改动；不得覆盖、回退无关改动。
- 按任务读取上面的相关文档，不要求每次全文重读所有 `docs/`；如存在 `docs/AI_HANDOFF.md`，先用它定位任务与交接状态，再以当前源码、配置、Git 差异及实际测试结果复核，交接记录不能代替核验。
- 明确区分四种状态：**需求已设计、代码已实现、验证已通过、任务已交付**。文档登记或代码存在不等于功能可用；测试通过也不自动说明所有产品验收条件满足。
- 现有代码与设计不一致时，先确认是未完成、缺陷、历史决策还是待变更需求；不得简单地把文档改成与现有代码一致，或擅自按未经批准的新设计重写实现。
- 需求或架构确需变化时，先说明变更理由、影响与取舍，按项目流程确认后在 `docs/90-决策与变更记录.md` 登记，并同步受影响的 `04/05/06/08` 及领域设计文档。修复明确偏离已批准设计的 Bug，无须把 Bug 当作新需求审批。

## 修改前的影响分析

- 确认本次变更属于 `server/`、`renderer/`、`shared/`、`desktop/src/`、`deploy/` 或跨模块变更；列出实际受影响的 API、类型、数据表、配置、任务状态、页面或测试，不因相邻代码可改就扩大范围。
- 修改共享 `server/` API、响应字段、鉴权或业务契约时，检查 `renderer/`（唯一前端）与 `desktop/` 主进程两处的调用与兼容性；修改仅属于渲染进程的 UI 时，不应无理由同步重做 Electron 主进程逻辑。
- 涉及多租户工作区、邀请码、用户权限或数据查询时，检查身份验证、权限控制、工作区范围隔离与越权访问风险；不能仅依赖前端隐藏按钮作为授权依据。
- 涉及数据库结构或数据语义时，核对实际迁移机制、旧数据兼容、回填需求及回退影响；未经确认不得执行会丢失数据的操作或直接改写生产数据。
- 涉及外部平台写入、批量操作、AI 自动执行或状态迁移时，逐项核对既有用户确认闸门、权限及 `docs/04/05/06` 契约；不得通过新增后台任务或接口变相绕过本文件的逐张执行红线。
- 涉及环境变量、部署或功能开关时，明确默认值、启用条件及可能影响的环境；不得以联调便利为由默认开放生产高风险开关。

## 实施与验证闭环

1. **建立基线**：阅读相关实现与测试，确认当前行为及问题是否可复现。根因尚不清楚时，不用临时绕过校验、吞异常或静默改变状态来制造“已修复”结果。
2. **最小完整修改**：按已确认需求实现必要变更，保留安全检查、错误处理及兼容性；清理仅因本次修改而失效的代码，不顺手改造无关模块。
3. **分层验证**：先运行与改动直接相关的测试、类型检查或构建；涉及后端业务与 HC 红线时运行适用的 Go 测试，涉及前端时运行 `renderer/` 单测与边界守卫，涉及用户旅程时运行桌面 E2E。`shared/` 或 `server/` 契约变更需同时检查 `renderer/` 与 `desktop/`；测试脚本先以仓库现存 `package.json`、CI 配置和工具链为准。
4. **不得假通过**：测试失败时记录失败用例、错误及是否由本次修改引入；不能删除、跳过、放宽测试来获取绿色结果，也不能仅凭 mock 成功宣称真实平台流程已验证。
5. **核对验收**：对照 `docs/04` 的验收标准及任务在 `docs/08` 的要求，核查正常流程、关键异常、权限边界及必要的桌面端形态差异。未执行的检查说明原因及剩余风险。
6. **同步记录**：仅在真实实现与验证结果支持时更新任务状态、验收记录和相关设计文档；不因代码提交而直接标记 `PROJECT_COMPLETE` 或等价状态。

## 安全、执行边界与交接

- 不泄漏真实密钥、访问令牌、用户私有数据或生产敏感配置；错误信息、截图、报告及示例数据也需避免敏感信息外泄。
- 不擅自执行破坏性 Git 操作（如强制推送、硬重置）、批量数据清理、生产迁移、真实平台发布或绕过用户确认的外部写入；需要此类操作时先取得明确授权。
- 执行长任务时记录已完成部分、修改文件、已运行的测试与结果、当前阻塞和下一步；如项目采用 `docs/AI_HANDOFF.md` 或其他既有交接机制，遵循其格式更新，避免另建重复状态源。
- 任务结束时简要报告：任务编号及实际修改、验证证据、未验证项与已知风险；缺失证据时不得声称已完成全部验收。

## 提交

- 一次一个任务，提交信息写任务编号，如 `DEV-109: 分段块编辑器`。
- 单人主干开发：按仓库既定工作流在 `main` 上小步提交，发布时打标签；提交前复核差异，仅包含当前任务的文件，不覆盖或夹带无关改动。
