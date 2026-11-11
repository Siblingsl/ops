# shared

双端（`web/` / `renderer/`）共用的纯类型与纯函数。

- `types.ts` / `format.ts`：权威源；两端 `lib/types.ts`、`lib/format.ts` 只做 `export *` 转发，不保留副本。
- 不含形态判断（`isElectronDesktop`）、产物路径、E2E support。
- 6.3 批2 采用「目录 + re-export」，不改两端 lockfile；批3 再考虑 `@ops/shared` 包与构建 job。
