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

五条路径覆盖文字作品、首次推荐、账号类型锁定、卡片与新类型派生限制。正文和本地图片通过 API 准备；大纲确认、逐段起草、逐卡生图、逐项检查、逐条采用和生成发布包通过浏览器操作。测试不修改业务状态来跳过人工门槛，也不接入真实平台或真实模型。

失败截图与 trace 在 `test-results/`，HTML 报告在 `playwright-report/`，均已忽略提交。可用 `pnpm exec playwright show-report` 查看报告，或 `pnpm exec playwright show-trace <trace.zip>` 查看具体失败过程。重复运行使用 `pnpm e2e --repeat-each=2`。该层补充 Go API/HC 回归，不能替代真实模型效果、真实平台草稿和视觉人工验收。

配置参考：[Playwright webServer](https://playwright.dev/docs/test-webserver)。
