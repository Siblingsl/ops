# RC-04 评论拟稿与人工采用

## 操作路径

1. 打开桌面 `/a/6c320a1b-b6f1-4897-b39f-13b12e854271/profile?tab=comments`。
2. 真实评论卡片正文「图1吧，图2人太大了」出现在「评论台账」。
3. 点击「AI 分类拟稿」。
4. 点击「复制草稿」，写回 `reply_status=copied`；未点击「确认已人工发送」，不对外发送。

## 结果

- `reply_status=copied`
- `category=question`
- `reply_draft` 长度 29 码点（≤80）
- `reply_revision=1`
- `author_alias` 为空
- `sent_manual_at` 为空（没有声称已发送）
- `ai_call_id` 已记录

回复草稿：

> 感谢反馈，这篇里第 2 步可以再展开说明，我补一篇详细版。

## 证据

- 截图：`04-comments-adopted.png`（评论台账显示「已复制」、草稿、未具名）。
- 数据：`03-comment-inbox.txt` 的 `reply_status/category/reply_draft` 字段。
- 说明：这是「采用」路径；未执行删除/拒绝路径，未自动外发。
