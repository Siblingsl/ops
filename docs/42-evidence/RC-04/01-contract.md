# RC-04 单篇详情与评论契约（真实实测）

## 1. 单篇详情入口

- 页面：创作中心 `/new/note-manager`。
- 卡片 `.note-card` 没有 `a[href]`；点击 `.note-card__cover` 由页面自身触发 `Page.windowOpen`。
- `Page.windowOpen` 返回的完整地址：
  - `https://www.xiaohongshu.com/explore/6a7c6caf0000000005033660?xsec_token=<redacted>&xsec_source=pc_creatormng`
- 实现只使用页面给出的这个地址，不拼接、不持久化 `xsec_token`。
- 目标作品：`note_id=6a7c6caf0000000005033660`，标题「哪个更真实？」。

## 2. 详情正文读取

- 本人创作中心入口 `GET` 公开详情页时，页面自身不请求 `/api/sns/web/v1/feed`。
- 正文来自页面 SSR：
  - `window.__INITIAL_STATE__.feed.undertakeNote.items[0].noteCard.title`
  - `window.__INITIAL_STATE__.feed.undertakeNote.items[0].noteCard.desc`
- 实测 `desc` 为 832 字；数据库 `platform_work_mirror` 中 `body_text` 长度 832，`content_state=complete`。
- 首页卡片入口的 JSON 详情接口是 `POST https://edith.xiaohongshu.com/api/sns/web/v1/feed`，body 键为 `source_note_id/image_formats/extra/xsec_source/xsec_token`，响应 `data.items[].note_card`；该接口不覆盖本人创作中心入口，因此实现走 SSR 页面状态。

## 3. 评论契约

- 页面自身请求：`GET/POST https://edith.xiaohongshu.com/api/sns/web/v2/comment/page`。
- 响应根：`data.comments[]`。
- 实测字段：`sub_comments/note_id/like_count/id/content/create_time/invalid/status/user_info/ip_location/at_users/liked/sub_comment_count`。
- 产品写入 `comment_inbox` 的真实记录：评论正文「图1吧，图2人太大了」（10 字）与作者回复「我感觉也是」。
- 昵称只可能出现在**桌面内存事实层**；`comment_inbox.author_alias` 为空，数据库不落平台昵称、用户 open_id 或 token。
- 详情页直接导航时不会稳定触发 `/comment/page`，产品读取优先使用同一公开详情页已渲染的 `.comment-item[id^="comment-"]` DOM，只取 `id/content/note_id`；保留 `/comment/page` 只读监听作为页面版本差异的兜底。两者读到的都是真实页面数据，不构造评论。

## 4. 不越权边界

- 只对本账号 `platform_work_mirror` 中已发布作品执行评论读取；不读取他人作品。
- 不调用发送接口，不自动外发；拟稿只写 `comment_inbox.reply_draft`，复制采用由用户点击完成。
