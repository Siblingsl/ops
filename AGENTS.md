# AGENTS.md

本仓库是"公众号 + 小红书 AI 辅助运营平台"（D-036 起：多租户工作区 + 邀请码协作；历史 MVP 为单用户）。设计文档在 `docs/`，开发前先读任务对应的文档条目。

## 先读文档再写代码

- 功能与验收标准：`docs/04-需求与功能分级.md`
- 页面与交互、异常处理：`docs/05-业务流程与交互.md`
- 数据表、模块、AI 任务契约、接口清单：`docs/06-数据与技术架构.md`
- 任务拆分与测试：`docs/08-开发与测试计划.md`
- 决策记录：`docs/90-决策与变更记录.md`（实现与设计不一致时，先在这里登记）
- 系统智能体（DEV-AG 任务）：`docs/16-系统智能体设计.md`（D-117）
- 账号类型迁移与创作模板（DEV-415/416）：`docs/18-账号类型迁移与创作模板设计.md`（D-123/D-124）
- 操作动线问题：`docs/22-操作动线问题清单.md`（所有动线问题统一追加在这里；改动前先查对应条目）
- 技能系统（DEV-SK 任务）：`docs/23-技能系统设计.md`（D-151）
  - DEV-SK 必须遵循 23 文档 v0.3 及后续登记版本的接口、权限、状态与验收契约；需要偏离时先更新 23 与 D-151。设计基线不表示功能已实现，按对应任务同步 04/05/06/08/16 的实施记录。

## 目录

```
server/                Go 后端（cmd/ops 为入口；internal/ 为业务模块）
web/                   React + TypeScript + Vite 网页端
  e2e/                 Web 浏览器场景 Playwright 用例
  tests/               Web 单测与源码边界守卫
desktop/               Electron 桌面端
  src/                 Electron 主进程与本机客户端能力
  renderer-src/        独立 React + TypeScript + Vite 桌面业务界面源码
    e2e/               桌面形态 Playwright 用例（含 Electron 真实窗口）
    tests/             桌面渲染器单测与边界守卫
  renderer/            桌面安装包使用的构建产物
deploy/                Docker Compose 与部署配置
docs/                  设计文档
```

`web/` 与 `desktop/renderer-src/` 是独立的前端项目，分别维护入口、依赖锁文件、构建配置、界面源码与 E2E 用例；共享业务功能需要在两处分别实现。`desktop/renderer/` 是生成目录，不直接编辑。

两套 E2E 各自独立运行，互不读取对方目录：

```powershell
cd web; pnpm e2e                    # Web：5179 / 8180 / 8191
cd desktop; pnpm test:e2e:renderer  # 桌面：5287 / 8287 / 8297
```

本机若设置了 `HTTP_PROXY` 而 `NO_PROXY` 未包含回环地址，Playwright 的 webServer 健康检查会被代理接管并一直超时（日志表现为服务已启动但持续 404）。两端配置已显式 `NO_PROXY=127.0.0.1,localhost,::1`；手工启动服务时也需自行排除。

`web/e2e/` 不允许出现 `_electron`、`Electron/` UA、`ops-creative-desktop`、5287 端口；`desktop/renderer-src/e2e/` 不允许引用 `web/` 或 5179 端口。两条约束由 `web/tests/web-e2e-boundary.test.mjs` 与 `desktop/renderer-src/tests/e2e-boundary.test.mjs` 在 `test:unit` 中强制。

两端截图与报告统一落在仓库根 `.playwright-results/`（CI 按该路径上传）。该目录按端分树，互不覆盖：`web/` 与 `web-report/` 属于 Web，`desktop-renderer/` 与 `desktop-renderer-report/` 属于桌面。桌面 runner 的 `process.cwd()` 是 `desktop/renderer-src`，所以桌面用例写产物必须用 `../../.playwright-results/` 和 `../../output/`；写成 `../` 会落到 `desktop/` 下，桌面边界测试会拦截。

仓库根 `output/` 同样按端分树：根层文件（如 `output/toutiao-*.png`）属于 Web，`output/playwright/` 属于桌面。两端的边界测试会分别拦截"Web 写 `output/playwright/`"和"桌面写 `output/` 根层"，因此两端可以同时跑。

`server/` 是**刻意共用**的后端，不属于两端任一侧的私有目录：`server/cmd/ops-e2e` 同时为两套 E2E 提供 API 与模拟模型，差异只由 `OPS_AGENT_WORKBENCH_FEATURES` 等环境变量控制。拆前端时不要把它复制成两份。

`web/e2e/` 与 `desktop/renderer-src/e2e/` 有 14 个同名 spec：它们覆盖同一段旅程的两种形态（浏览器 / 桌面工作台），必须各写一份，不能共用文件。同名清单与"每对至少 15 行差异"由根目录 `scripts/check-e2e-pairs.mjs` 在 CI 的 `e2e` job 中校验；新增同名要显式登记，直接复制一端到另一端会被拦下。

## 本地开发

```powershell
docker compose -f deploy/docker-compose.dev.yml up -d   # PostgreSQL，端口 5440
cd server; go run ./cmd/ops serve                       # API :8080，模拟微信与模拟模型 :8091
cd web; pnpm install; pnpm dev                          # 前端 :5173，代理 /api 到 :8080
```

桌面端开发与构建：

```powershell
cd desktop; pnpm install --frozen-lockfile
pnpm --dir renderer-src install --frozen-lockfile
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

## 提交

- 一次一个任务，提交信息写任务编号，如 `DEV-109: 分段块编辑器`。
- 单人主干开发：直接在 `main` 上小步提交，发布时打标签。
