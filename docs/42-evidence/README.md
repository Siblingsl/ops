# 42 真实闭环证据目录

本目录只放 `docs/42-真实闭环验收总台账.md` 各 RC 的真实闭环证据，不放开源测试夹具或 mock 结果。

## 目录规范

```text
docs/42-evidence/RC-01/
  run.md              # 环境、账号别名、操作、结果、失败恢复
  screenshot-01.png   # 脱敏截图
  response-01.json    # 脱敏响应/数据库行
  command.log         # 命令与退出码（不含密钥）
```

## 红线

- 不存 AppSecret、access_token、API Key、SMTP 密码、tenant_access_token、open_id、手机号、用户昵称。
- 截图必须脱敏；平台后台截图遮住账号名、头像、二维码。
- 不用 mock/夹具截图冒充真实平台。
- 失败样本保留；不得只留成功截图。
- 每个 RC 的 `run.md` 必须写清：真实系统、用户路径、失败与恢复、证据列表、结论。
