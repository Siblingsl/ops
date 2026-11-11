# shared

双端（`web/` / `renderer/`）共用的纯类型与纯函数。

- 批2：`types.ts` / `format.ts`
- 批3（无 npm 依赖子集）：`api-base.ts` / `api-retry.ts` / `render-policy.ts` / `custom-theme-state.ts`
- 两端对应 `lib/*` 只做 `export *` 转发，不保留副本。
- **未下沉**：`api.ts` / `render.ts` / `components/ui.tsx`——依赖 `sonner`/`marked`/`react` 等，移出端内 `node_modules` 后 tsc 无法解析；双端内容已用契约测试断言同口径（`ui` 允许桌面 `useEmbeddedSettings` 差异）。
- 不含形态判断、产物路径、E2E support。
- 采用「目录 + re-export」，不改两端 lockfile；未建 `@ops/shared` npm 包。
