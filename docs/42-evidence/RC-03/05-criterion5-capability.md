# RC-03 第 5 条：能力快照刷新

判定：**FAIL（未刷新）**

## 当前快照（DB 原样）

```json
{
  "workList": "supported",
  "detectedAt": "2026-10-22T07:59:25.209Z",
  "creatorLogin": "supported",
  "followerTotal": "unknown",
  "mainSiteLogin": "supported",
  "adapterVersion": "xhs-1",
  "browserVersion": "Chrome/155.0.8059.85",
  "mappingVersion": 1,
  "perNoteMetrics": "unknown",
  "noteImpressions": "unknown",
  "sessionTtlObserved": null
}
```

原始行见 `05-capabilities-db.txt`。

## 与实际状态的差异

| 项 | 快照 | 实际 | 结论 |
|---|---|---|---|
| detectedAt | `2026-10-22T07:59:25.209Z` | 本轮 2026-11-23 未产生新的成功核验 | 未刷新 |
| browserVersion | `Chrome/155.0.8059.85` | 真实 401 登录浏览器 `Chrome/158.0.8127.36` | 不一致、未刷新 |
| sessionTtlObserved | `null` | 已观测 1/3 次，尚无 3 次样本 | 保持 null，正确 |
| perNoteMetrics | `unknown` | 本轮未做成功的能力探测 | 保持 unknown，正确 |
| noteImpressions | `unknown` | 本轮未做成功的能力探测 | 保持 unknown，正确 |
| followerTotal | `unknown` | 本轮未做成功的能力探测 | 保持 unknown，正确 |
| workList / creatorLogin / mainSiteLogin | `supported` | 来自 10-22 的成功登录探测；当前连接已失效 | 旧值，未降级、未刷新 |

## 为什么没有刷新

- 能力快照由成功登录核验/能力探测写入；当前连接 `availability=login_required`，真实登录未完成，不能产生新的成功探测。
- 没有用 API 直接 PATCH、SQL UPDATE 或 mock 数据把 `unknown` 改成 `supported`，也没有改 `browserVersion`/`detectedAt` 伪造刷新。
- 服务端 `platform_capabilities.xhs` 四键仍全 `unknown`，见 `01-capabilities.json`；与连接快照的 `supported` 旧值并存，说明服务端能力目录尚未被真实探测抬起。

## 通过条件（未满足）

1. 用户完成真实重登，桌面成功核验身份与作品列表；
2. 连接 `detectedAt`、`browserVersion` 更新为当前真实值；
3. `perNoteMetrics`/`noteImpressions`/`followerTotal` 只有在真实探测成功时才可抬 `supported`；探测不到继续保持 `unknown`；
4. `sessionTtlObserved` 仅在 3 次真实 TTL 样本齐备后写入非 null。

在真实重登前，本条保持 FAIL；不得以“快照里已有 supported 键”冒充本轮刷新。
