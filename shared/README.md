# shared

双端（`web/` / `renderer/`）共用的纯类型与纯函数，以及已对齐的契约模块。

- 批2：`types.ts` / `format.ts`
- 批3：`api-base.ts` / `api-retry.ts` / `render-policy.ts` / `custom-theme-state.ts` / `api.ts` / `render.ts`
- 续：`skill-canon.ts`（纯函数，无 npm 依赖）
- 批4：`platform-errors.ts` / `zip.ts` / `skills.ts` / `cover-build.ts` / `agent-events.ts`（依赖仅指向同目录 `types` / `skill-canon` / `api`）
- 批5：`canonical-json.ts` / `cx-render-contract.ts` / `keyboard.ts` / `legacy-article.ts` / `local-draft.ts` / `recent.ts` / `theme-contrast.ts`（零 import）
- 批6：`ai-error.ts` / `undo.ts`（`sonner` + `./api`；走既有 vite-dep-alias）
- **仍双端保留**：含 React / react-query 的 `agent.ts` / `agent-invalidate.ts` / `visibility.ts` / `wechat-html.ts`
- 两端对应 `lib/*` 只做 `export *` 转发，不保留副本。
- `api.ts` / `render.ts` 依赖 `sonner` / `marked`：两端 `tsconfig.json` `paths` + `vite-dep-alias.mjs`（vite.config 与 SSR 单测）指回本包 `node_modules`；未建 `@ops/shared`、未改 lockfile。
- **未下沉**：`components/ui.tsx`——桌面有意保留 `useEmbeddedSettings` / `desktop-settings`，与 Web 不同；契约测试断言仅允许该差异。`section-editor` / `editor-tools` 依赖 tiptap/react + 本地 UI，不下沉。
- 不含形态判断、产物路径、E2E support。
- 采用「目录 + re-export」，不改两端 lockfile。
