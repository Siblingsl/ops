# 本地浏览器冒烟（DEV-U110）

在仓库根目录启动 PostgreSQL，再进入 web：

```powershell
docker compose -f deploy/docker-compose.dev.yml up -d
cd web
pnpm install
pnpm exec playwright install chromium
pnpm e2e
```

测试自行启动本地 API（8180）、模型/微信 mock（8191）和 Vite（5179）；端口被占用时失败，不复用未知服务。数据库只允许连接本地开发库，创建并使用 `ops_e2e`，不清空或删除数据库；不会使用日常 `ops` 或 Go 测试 `ops_test` 中的业务数据。每次注册独立测试用户，图片写入系统临时目录 `ops-e2e-assets`。默认密码、加密密钥均只用于 mock 测试。需要调整本地数据库凭证时设置 `OPS_E2E_ADMIN_URL`，主机必须是 localhost/127.0.0.1、初始库必须是 ops。

六条路径覆盖文字作品、首次推荐、账号类型锁定、卡片、新类型派生限制与副驾驶逐条删除确认/稳定目标。正文和本地图片通过 API 准备；大纲确认、逐段起草、逐卡生图、逐项检查、逐条采用和生成发布包通过浏览器操作。测试不修改业务状态来跳过人工门槛，也不接入真实平台或真实模型。

失败截图与 trace 在 `test-results/`，HTML 报告在 `playwright-report/`，均已忽略提交。可用 `pnpm exec playwright show-report` 查看报告，或 `pnpm exec playwright show-trace <trace.zip>` 查看具体失败过程。重复运行使用 `pnpm e2e --repeat-each=2`。该层补充 Go API/HC 回归，不能替代真实模型效果、真实平台草稿和视觉人工验收。

OPT-17 / D-070：main 推送和面向 main 的 PR 通过 `.github/workflows/ci.yml` 的独立 E2E job 运行完整用例。PostgreSQL、Go、Node 与 Chromium 均在临时 runner 中准备，API/模型/微信由 `ops-e2e` 启动并只连接本地模拟服务；失败上传 trace、截图和 HTML 报告。`opt17.spec.ts` 覆盖公众号长文逐段起草、人工编辑待核实内容、逐项确认检查、单篇写入草稿箱，以及人工回填已发布后录入第一天节点数据；不执行平台发表。

CI 固定 pnpm 10.14.0 并通过 `pnpm install --frozen-lockfile` 使用唯一锁文件 `pnpm-lock.yaml`；Playwright 启动前端也使用 `pnpm dev`。仓库配置与本地通过不能代替远端 CI 的实际运行记录；本任务不推送或触发部署。失败产物上传参数参考 [upload-artifact](https://github.com/actions/upload-artifact)，浏览器安装参考 [Playwright CI](https://playwright.dev/docs/ci-intro)。

配置参考：[Playwright webServer](https://playwright.dev/docs/test-webserver)。

生产打包验收（DEV-U103）在仓库根目录运行：

```powershell
docker compose -p ops-prod-e2e -f deploy/docker-compose.prod.yml -f deploy/docker-compose.e2e.yml config --quiet
docker compose -p ops-prod-e2e -f deploy/docker-compose.prod.yml -f deploy/docker-compose.e2e.yml up -d --build --wait
cd web
$env:OPS_E2E_PROD = '1'
pnpm e2e
Remove-Item Env:OPS_E2E_PROD
cd ..
docker compose -p ops-prod-e2e -f deploy/docker-compose.prod.yml -f deploy/docker-compose.e2e.yml stop
```

此模式固定连接 `127.0.0.1:44538`，API 使用 `OPS_DEV=0`、生产静态资源与独立 `ops-prod-e2e` 数据卷；内部 mock 容器提供模型/微信测试接口，不对外暴露。覆盖文件清除生产 `.env` 依赖并覆盖测试密钥/数据库口令/接口地址，不能用作真实部署。Compose 可能提示原文件变量未设置，合并后的值均由测试覆盖文件提供。每次测试新注册用户、显式配置 mock 模型，并在浏览器退出后重新密码登录；不跳过人工创作门槛。默认本地 Vite 模式保持不变。

升级/回滚演练可用 `OPS_E2E_IMAGE` 在本地旧测试镜像与 `ops-app:prod-e2e` 间切换。切换前保存数据库与 assets；回滚需配套恢复该镜像对应备份，不用 Down 强行收紧已有新类型约束。测试结束只停止此项目，保留卷供排查；不会删除日常开发数据库或操作线上部署。
