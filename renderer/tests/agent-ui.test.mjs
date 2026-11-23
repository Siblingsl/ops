import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addToLimitedList, browserModeSummary, buildRunTimeline, conversationRowState, deriveHeaderState, latestBrowserActivity, mergeAgentErrors,
  detectComposerTrigger, formatDuration, formatTokens, mapAgentError, onboardingHint, pendingItems, removeComposerTrigger,
  shouldAutoOpenPanel, tabLabel, tabCountLabel, modelRowMeta, MODE_OPTIONS, modeActionLabel, skillStateLabel,
  contextRefsPayload, skillRequestsPayload, shouldPromptDraftSwitch,
} from '../lib/agent-ui.js'

test('formatTokens 覆盖 0/999/1k/12.4k/1.2m', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(null), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(12400), '12.4k')
  assert.equal(formatTokens(1_200_000), '1.2m')
})

test('deriveHeaderState：运行中优先级最高', () => {
  const state = deriveHeaderState({ hasConversation: true, title: '发布检查', accountName: '公众号 A', mode: 'execute', activeRun: { status: 'running' }, pendingActions: 2, pendingQuestions: 1, usage: { prompt_tokens: 12000, completion_tokens: 400 } })
  assert.equal(state.title, '发布检查')
  assert.equal(state.status.label, '运行中')
  assert.equal(state.modeLabel, '执行（逐卡确认）')
  assert.equal(state.usage.label, '12.4k')
})

test('deriveHeaderState：待处理合并卡片与问题', () => {
  const state = deriveHeaderState({ hasConversation: true, pendingActions: 2, pendingQuestions: 1, usage: null })
  assert.equal(state.status.label, '待你处理 3')
  assert.equal(state.status.count, 3)
  assert.equal(state.usage, null)
})

test('deriveHeaderState：暂停/阻塞/预算/观察者/无模型', () => {
  assert.equal(deriveHeaderState({ hasConversation: true, goalStatus: 'paused' }).status.label, '已暂停')
  assert.equal(deriveHeaderState({ hasConversation: true, goalStatus: 'blocked' }).status.label, '已阻塞')
  assert.equal(deriveHeaderState({ hasConversation: true, goalStatus: 'budget_limited' }).status.label, '预算已用尽')
  assert.equal(deriveHeaderState({ readOnly: true, hasConversation: true }).observer, true)
  const missing = deriveHeaderState({ canUse: false, reason: 'not_tested', hasConversation: true })
  assert.equal(missing.modelMissing, true)
  assert.equal(missing.modelReason, 'not_tested')
  assert.equal(missing.status.label, '已就绪')
})

test('deriveHeaderState：空对话不显示待开始', () => {
  const state = deriveHeaderState({ hasConversation: false, accountName: '不指定账号', mode: 'execute' })
  assert.equal(state.title, 'AI 对话')
  assert.equal(state.status.label, '')
  assert.equal(state.accountLine, '不指定账号')
})

test('deriveHeaderState：连接中断仍表示任务在运行', () => {
  const state = deriveHeaderState({ hasConversation: true, activeRun: { status: 'running' }, connection: 'reconnecting' })
  assert.equal(state.status.label, '连接中断，任务仍在运行')
  assert.equal(state.status.tone, 'paused')
})

test('conversationRowState 优先级：运行 > 待处理 > 待回答 > 暂停 > 未读', () => {
  assert.equal(conversationRowState({ has_active_run: true, pending_actions: 2 }).label, '运行中')
  assert.equal(conversationRowState({ pending_actions: 2, pending_questions: 1 }).label, '待你处理 3')
  assert.equal(conversationRowState({ pending_questions: 2 }).label, '待回答 2')
  assert.equal(conversationRowState({ goal: { status: 'paused' } }).label, '已暂停')
  assert.equal(conversationRowState({ has_unread: true }).dot, true)
  assert.equal(conversationRowState({}).label, '就绪')
  assert.equal(conversationRowState({ archived_at: '2026-01-01' }).label, '已归档')
})

test('shouldAutoOpenPanel：空对话不恢复偏好，有内容才自动开', () => {
  assert.equal(shouldAutoOpenPanel({ savedOpen: true, conversationId: '' }), false)
  assert.equal(shouldAutoOpenPanel({ savedOpen: true, conversationId: 'c1' }), true)
  assert.equal(shouldAutoOpenPanel({ savedOpen: false, conversationId: 'c1', pendingActions: 1 }), true)
  assert.equal(shouldAutoOpenPanel({ savedOpen: false, conversationId: 'c1' }), false)
})

test('tabCountLabel 只显示正数、封顶 99+', () => {
  assert.equal(tabCountLabel(0), '')
  assert.equal(tabCountLabel(3), '3')
  assert.equal(tabCountLabel(120), '99+')
})

test('tabLabel：标题优先，空标题回退 host+path，超长截断', () => {
  assert.equal(tabLabel({ title: '公众号后台', url: 'https://mp.weixin.qq.com/cgi-bin/home' }).label, '公众号后台')
  const fallback = tabLabel({ title: 'https://mp.weixin.qq.com/cgi-bin/appmsg', url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?x=1' })
  assert.equal(fallback.label, 'mp.weixin.qq.com/cgi-bi…')
  assert.equal(fallback.full, 'https://mp.weixin.qq.com/cgi-bin/appmsg?x=1')
  const long = tabLabel({ title: '一二三四五六七八九十一二三四五六七八九十一二三四五', url: 'https://a.b' })
  assert.equal(Array.from(long.label).length, 24)
  assert.ok(long.label.endsWith('…'))
  // Chrome 无 <title> 时会把地址（不含协议）当标题，仍应回退 host+path。
  const addressTitle = tabLabel({ title: '127.0.0.1:8287/healthz', url: 'http://127.0.0.1:8287/healthz' })
  assert.equal(addressTitle.label, '127.0.0.1/healthz')
  assert.equal(addressTitle.full, 'http://127.0.0.1:8287/healthz')
})

test('detectComposerTrigger：@ / / / $，组字中不打开，邮箱与 https 不误触', () => {
  assert.deepEqual(detectComposerTrigger('看下 @作', 5, false), { kind: 'at', query: '作', start: 3, end: 5 })
  assert.equal(detectComposerTrigger('a@b.com', 6, false), null)
  assert.equal(detectComposerTrigger('https://mp.weixin.qq.com', 24, false), null)
  assert.deepEqual(detectComposerTrigger('/pl', 3, false), { kind: 'slash', query: 'pl', start: 0, end: 3 })
  assert.deepEqual(detectComposerTrigger('用 $选', 4, false), { kind: 'skill', query: '选', start: 2, end: 4 })
  assert.equal(detectComposerTrigger('@作', 2, true), null)
  assert.equal(detectComposerTrigger('普通文本', 4, false), null)
})

test('removeComposerTrigger 只删触发词，保留前后文与光标', () => {
  const trigger = detectComposerTrigger('看看 @作品 的标题', 6, false)
  const result = removeComposerTrigger('看看 @作品 的标题', trigger)
  assert.equal(result.text, '看看  的标题')
  assert.equal(result.caret, 3)
})

test('IX-10：移除引用/技能后发送投影不再包含被删项', () => {
  const refs = [
    { type: 'work', id: 'w1', revision: 3, reference_scope: 'turn', name: '作品 A' },
    { type: 'material', id: 'm1', revision: 5, reference_scope: 'conversation', name: '素材 B' },
  ]
  assert.deepEqual(contextRefsPayload(refs).map((item) => item.id), ['w1', 'm1'])
  assert.equal(contextRefsPayload(refs).every((item) => !('name' in item)), true)
  assert.deepEqual(contextRefsPayload([refs[1]]).map((item) => item.id), ['m1'])
  const artifact = { type: 'artifact_version', id: 'v2', artifact_id: 'a1', revision: 'h2', reference_scope: 'turn', anchor: { start: 0, end: 2, quote_hash: 'q', quote: '选段' } }
  assert.equal(contextRefsPayload([artifact])[0].artifact_id, 'a1')
  assert.equal(contextRefsPayload([refs[0]])[0].artifact_id, undefined)
  const requests = [{ skill_id: 's1', name: '技能 A' }, { skill_id: 's2', work_id: 'w2', name: '技能 B' }]
  assert.deepEqual(skillRequestsPayload(requests).map((item) => item.skill_id), ['s1', 's2'])
  assert.deepEqual(skillRequestsPayload([requests[0]]), [{ skill_id: 's1' }])
})

test('skillStateLabel：未装入 / 已请求 / 已加载 / 撤权四态不混淆', () => {
  assert.equal(skillStateLabel(), '未装入')
  assert.equal(skillStateLabel({ requested: true }), '已请求，未加载')
  assert.equal(skillStateLabel({ requested: true, loaded: true }), '已加载到模型上下文；实际使用未验证')
  assert.equal(skillStateLabel({ requested: true, unavailable: true }), '不可用，移除')
})

test('addToLimitedList：去重与上限都返回原因', () => {
  const list = [{ id: 'a' }]
  assert.equal(addToLimitedList(list, { id: 'a' }, 8, (v) => v.id).reason, 'duplicate')
  assert.equal(addToLimitedList(list, { id: 'b' }, 1, (v) => v.id).reason, 'limit')
  assert.deepEqual(addToLimitedList(list, { id: 'b' }, 2, (v) => v.id).list.map((v) => v.id), ['a', 'b'])
  const twelve = Array.from({ length: 12 }, (_, index) => ({ id: `ref-${index}` }))
  assert.equal(addToLimitedList(twelve, { id: 'ref-0' }, 12, (v) => v.id).reason, 'duplicate')
  assert.equal(addToLimitedList(twelve, { id: 'ref-12' }, 12, (v) => v.id).reason, 'limit')
})

test('shouldPromptDraftSwitch：只在已有草稿且切到另一张卡时提示', () => {
  assert.equal(shouldPromptDraftSwitch('a', 'b', true), true)
  assert.equal(shouldPromptDraftSwitch('a', 'a', true), false)
  assert.equal(shouldPromptDraftSwitch('a', 'b', false), false)
  assert.equal(shouldPromptDraftSwitch('', 'b', true), false)
})

test('formatDuration：极短耗时用 <0.1 秒，正常保留一位小数', () => {
  assert.equal(formatDuration(20), '<0.1 秒')
  assert.equal(formatDuration(2000), '2.0 秒')
})

test('buildRunTimeline：全成功默认折叠，头行标题含总量与总用时', () => {  const timeline = buildRunTimeline({
    toolCalls: [
      { name: 'load_tool_domain', domain: 'works', status: 'done', duration_ms: 200 },
      { name: 'works__get', domain: 'works', status: 'done', duration_ms: 1200 },
      { domain: 'works', status: 'done', duration_ms: 800 },
    ],
  })
  assert.equal(timeline.status, 'done')
  assert.equal(timeline.objects, 2)
  assert.equal(timeline.durationMs, 2000)
  assert.equal(timeline.title, '已读取 2 项资料，用时 2.0 秒')
  assert.equal(timeline.rows[0].defaultOpen, undefined)
})

test('buildRunTimeline：按 domain 聚合，失败展开、总量与耗时', () => {
  const timeline = buildRunTimeline({
    toolCalls: [
      { domain: 'works', status: 'done', duration_ms: 1200 },
      { domain: 'works', status: 'done', duration_ms: 800 },
      { domain: 'checks', status: 'error', duration_ms: 400 },
    ],
    actions: [{ id: 'a1', status: 'pending', title: '改标题' }],
  })
  assert.equal(timeline.status, 'failed')
  assert.equal(timeline.objects, 4)
  assert.equal(timeline.rows.length, 3)
  assert.equal(timeline.rows[0].title, '读取作品 2 项 · 作品')
  assert.equal(timeline.rows[0].defaultOpen, undefined)
  assert.equal(timeline.rows[1].defaultOpen, true)
  assert.equal(timeline.rows[2].title, '提出 1 张修改卡片')
  assert.match(timeline.title, /失败/)
})

test('buildRunTimeline：计划步骤优先，等待用户默认展开', () => {
  const timeline = buildRunTimeline({
    plan: { steps: [{ id: 's1', title: '读取账号数据' }, { id: 's2', title: '生成选题' }], step_states: [{ step_id: 's1', status: 'completed' }, { step_id: 's2', status: 'waiting_user' }] },
    toolCalls: [{ domain: 'metrics', status: 'done', step_id: 's1', duration_ms: 500 }],
  })
  assert.deepEqual(timeline.rows.map((row) => row.title), ['读取账号数据', '生成选题'])
  assert.equal(timeline.rows[1].defaultOpen, true)
  assert.equal(timeline.status, 'waiting')
})

test('buildRunTimeline：没有活动时返回 null，不伪造步骤', () => {
  assert.equal(buildRunTimeline({ toolCalls: [], actions: [] }), null)
})

test('mapAgentError：模型不支持/引用失效/权限/结果未知都给出恢复动作', () => {
  assert.equal(mapAgentError({ code: 'model_not_supported', message: '模型未自检' }).actions[0].label, '换模型')
  assert.equal(mapAgentError({ code: 'context_unavailable' }).actions[0].label, '重新选择')
  assert.equal(mapAgentError({ code: 'permission_denied' }).actions.some((a) => a.id === 'open-permissions'), true)
  const unknown = mapAgentError({ code: 'result_unknown', request_id: 'req-1' })
  assert.equal(unknown.title, '执行结果未确认')
  assert.equal(unknown.actions[0].label, '核对结果')
  assert.equal(unknown.actions.at(-1).label, '复制请求 ID')
  const internal = mapAgentError({ code: 'internal', message: '模拟读取失败', requestId: 'req-e2e-123' })
  assert.equal(internal.title, '服务暂时不可用')
  assert.equal(internal.reason, '模拟读取失败')
  assert.equal(internal.requestId, 'req-e2e-123')
  assert.equal(internal.actions.at(-1).label, '复制请求 ID')
  assert.equal(mapAgentError({ code: 'rate_limited', request_id: 'req-rate' }).title, '请求过于频繁')
  assert.equal(mapAgentError({ code: 'rate_limited' }).actions[0].label, '稍后重试')
  assert.equal(mapAgentError({ code: 'network' }).title, '连接中断')
  assert.equal(mapAgentError({ code: 'network' }).actions[0].label, '重试')
})

test('mergeAgentErrors：同一 run 去重、保留顺序、允许 3 条以上查看全部', () => {
  const first = { code: 'rate_limited', message: '请求过于频繁', requestId: 'req-1' }
  const second = { code: 'network', message: '连接中断', requestId: 'req-2' }
  const merged = mergeAgentErrors([first, second, first, '', null])
  assert.equal(merged.length, 2)
  assert.equal(merged[0], first)
  assert.equal(merged[1], second)
  assert.equal(mergeAgentErrors([first, second, { code: 'internal', message: '失败', requestId: 'req-3' }, { code: 'timeout', message: '超时', requestId: 'req-4' }]).length, 4)
})

test('pendingItems：只列待处理，合并卡片与问题', () => {
  const items = pendingItems({ actions: [{ id: 'a', status: 'pending', title: '改标题', target: { name: '文章' } }, { id: 'b', status: 'succeeded' }], questions: [{ id: 'q', status: 'pending', items: [{ title: '选哪个标题' }] }] })
  assert.equal(items.length, 2)
  assert.equal(items[0].status, '待你处理')
  assert.equal(items[1].status, '待回答')
})

test('onboardingHint：只显示一条，只读优先', () => {
  assert.equal(onboardingHint({ readOnly: true, canUse: false, reason: 'no_model' }).id, 'readonly')
  assert.equal(onboardingHint({ canUse: false, reason: 'no_model' }).action, '去模型配置')
  assert.equal(onboardingHint({ canUse: false, reason: 'not_tested' }).id, 'not-tested')
  assert.equal(onboardingHint({ canUse: true, hasAccount: false }).id, 'no-account')
  assert.equal(onboardingHint({ canUse: true, hasAccount: true }), null)
})

test('browserModeSummary：应用内=仅本机，Chrome 三态不伪造已连接', () => {
  assert.equal(browserModeSummary('inapp').note, '你自己浏览，Agent 不会操作这里')
  assert.equal(browserModeSummary('chrome').label, '未连接')
  assert.equal(browserModeSummary('chrome', { paired: 2 }).label, '已连接 2')
  assert.equal(browserModeSummary('chrome', { authorizing: true }).label, '操作中')
})

test('latestBrowserActivity：只取运行中的 browser_*，跳过 tab 选择与已结束调用', () => {
  assert.equal(latestBrowserActivity([]), null)
  assert.equal(latestBrowserActivity([{ tool_calls: [
    { id: 'done', name: 'browser_observe', status: 'done', summary: '观察标签' },
    { id: 'pick', name: 'browser_request_tab', status: 'running', summary: '选择标签' },
  ] }]), null)
  const activity = latestBrowserActivity([
    { tool_calls: [{ id: 'old', name: 'browser_observe', status: 'done' }] },
    { tool_calls: [{ id: 'live', name: 'browser_navigate', status: 'running', summary: '操作标签 A' }] },
  ])
  assert.deepEqual(activity, { id: 'live', name: 'browser_navigate', label: '操作标签 A' })
})

test('modelRowMeta：供应商 + 工具/看图 + 自检状态，不显示推理强度', () => {
  assert.equal(modelRowMeta({ provider_name: '本地', tools: true, vision: true, self_test: 'passed' }), '本地 · 工具 · 看图 · 已自检')
  assert.equal(modelRowMeta({ provider_name: '远端', tools: true, self_test: 'untested' }), '远端 · 工具 · 未自检')
  assert.equal(modelRowMeta({ provider_name: '远端', tools: true, self_test: 'failed' }), '远端 · 工具 · 自检失败')
})

test('IX-06：模式说明与发送文案一一对应，执行明确逐卡确认', () => {
  assert.equal(modeActionLabel('execute'), '发送')
  assert.equal(modeActionLabel('plan'), '生成计划')
  assert.equal(modeActionLabel('discuss'), '提问')
  assert.equal(MODE_OPTIONS.length, 3)
  assert.match(MODE_OPTIONS.find((item) => item.id === 'execute').desc, /逐张确认/)
  assert.match(MODE_OPTIONS.find((item) => item.id === 'execute').desc, /不批量执行/)
})
