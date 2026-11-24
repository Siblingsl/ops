# RC-02 证据归档：微信公众号数据回收与粉丝趋势

- 执行日期：2026-11-23（CST）
- 账号：公众号「REF41 真实公众号」，个人主体、未认证（平台账号 `8be65226-3bbc-4f96-b1c2-215f60d0ca71`）
- 环境：本机 `127.0.0.1:18081`，`OPS_DEV=0`，真实 `https://api.weixin.qq.com`，数据库 `ops_ref41`
- 凭证：真实 AppID/AppSecret 只从加密配置读取；未写入文档/日志/夹具/git
- 结论：**未闭环-待认证号**。权限降级路径 PASS；真实行、来源、7 天趋势未达成。
- 阻断（2026-11-23，用户确认）：当前没有企业/组织主体公众号，无法取得微信认证号；本项暂停推进，不设内部完成日期。

## 关键结果

1. 真实 `GetToken` 成功；`getarticletotal`、`getusersummary`、`getusercumulate` 三个真实端点均返回
   `errcode=48001 api unauthorized`。
2. 产品同步路由返回 HTTP 403 `wechat_capability`，`datacube_state=no_permission`；真实账号
   `account_metric_daily` 为 0 行、`source='wechat_api'` 为 0 行。
3. Web 复盘页真实显示 no_permission 提示，同步按钮 0 个；粉丝卡显示未采集、无伪造 0，并提供「补录一天」。
4. RunJobs 对真实账号候选数为 0（缺 `datacube_state='ok'`），没有产生真实行；这是正确降级。
5. 本地开发库存在 25 行 `source='wechat_api'` 的 mock 行（AppID `wx1234567890abcdef`、规则等差数值），
   已明确排除，不计入任何通过项。
6. `TestDR03WechatDatacubeSync`、`TestDR06WechatDailySync` 等定向回归 PASS（测试库/mock），证明
   datacube 解析/权限映射/每日同步代码路径无回归，不代表真实认证号数据。

## 判定

| 条件 | 结果 |
|---|---|
| 真实凭证/个人号分支登记 | PASS（分支） |
| 真实行 + `source=wechat_api` | FAIL（0 行） |
| 连续 7 天趋势 | FAIL（无认证号，未开始） |
| 权限降级 `no_permission` + UI + 人工路径 | PASS |

**总判定：未闭环。** 解除条件见 `验收报告.md` §4：认证号 + 加密凭证 + IP 白名单 + datacube_state=ok +
连续 7 天真实数据 + 与后台同口径核对。

详细执行与证据索引见 `验收报告.md`；原始证据见同目录 `00`–`10` 文件与 PNG/JSON。
