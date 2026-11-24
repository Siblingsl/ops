# RC-04 验证记录

## 最终代码状态

- `desktop/src/platform-login.ts`：详情/评论触发、页面给出 URL、SSR 详情读取、评论区已渲染 DOM 读取；详情后恢复 `note-manager`。
- `desktop/src/platforms/xhs.ts`：`noteContent` 由详情真实正文探测；`fetchComments` 事实层；昵称只在内存。
- `desktop/src/platform-login-runtime.ts`：`findOwnedConnection` 使用 `is_holder`；identity-only 复核。
- `desktop/src/main.ts`：`pacedPlatformSource`、content 阶段 `title` fallback、评论逐条上报。
- `server/internal/app/platform_comment_http.go`：多连接按 `external_account_key` 优先匹配。
- 临时验收用的 30s tick、daily window 0、budget bypass、跳过发布领取、claim 诊断日志均已恢复/删除。

## 命令

```text
cd desktop; pnpm build
cd desktop; node --test test/platform-login-flow.test.cjs test/platform-xhs.test.cjs test/platform-collect.test.cjs
cd server; go test ./internal/app -run '^TestPlatformV2Content|^TestP04CommentIngestEndpoint|^TestPlatformSyncComment|^TestP04Comment' -count=1
cd server; go vet ./internal/app
```

## 结果

- desktop build：EXIT=0。
- desktop 定向：48 tests，48 pass，0 fail，EXIT=0；包含 `CF-PS-04`、`CF-PS-07`、`CF-P2-CXEF-06` 守卫。
- Go 定向：`ok ops/internal/app 8.322s`，EXIT=0（2026-11-24 复跑）。
- `go vet ./internal/app`：EXIT=0。

## 真实环境核对

- `platform_connection` 能力快照：`availability=ready`，`noteContent/workList/perNoteMetrics=supported`，`last_verified_at=2026-11-23T15:29:36.721301Z`。
- `platform_work_mirror`：`content_state=complete`，`char_length(body_text)=832`。
- `comment_inbox`：2 条真实评论，`author_alias` 全空，1 条 `reply_status=copied`，`sent_manual_at` 为空。
