import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT08 二十段选区与自动保存仅更新当前段，Profiler 提交小于16ms', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { record: false, commits: [] as { sections: string[]; sectionDurations: { id: string; duration: number }[]; duration: number; owners: { name: string; duration: number }[] }[] }
    ;(window as any).__opt08 = state
    ;(window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(), inject: () => 1,
      onCommitFiberRoot: (_renderer: number, root: any) => {
        if (!state.record) return
        const sections: string[] = []
        const sectionDurations: { id: string; duration: number }[] = []
        const owners: { name: string; duration: number }[] = []
        const previousFibers = new Set<any>()
        const findPrevious = (fiber: any) => {
          if (!fiber) return
          previousFibers.add(fiber)
          findPrevious(fiber.child)
          findPrevious(fiber.sibling)
        }
        findPrevious(root.current.alternate)
        const previousSections = new Map<string, any>()
        const findPreviousSections = (fiber: any) => {
          if (!fiber) return
          if (fiber.memoizedProps?.section && fiber.memoizedProps?.onSave) previousSections.set(fiber.memoizedProps.section.id, fiber)
          findPreviousSections(fiber.child)
          findPreviousSections(fiber.sibling)
        }
        findPreviousSections(root.current.alternate?.child)
        const visit = (fiber: any) => {
          if (!fiber) return
          if (fiber.memoizedProps?.section && fiber.memoizedProps?.onSave && previousSections.get(fiber.memoizedProps.section.id) !== fiber) {
            sections.push(fiber.memoizedProps.section.id)
            sectionDurations.push({ id: fiber.memoizedProps.section.id, duration: fiber.actualDuration })
          }
          if (!previousFibers.has(fiber)) {
            const type = fiber.type?.type ?? fiber.type
            if (typeof type === 'function') owners.push({ name: type.displayName || type.name, duration: fiber.actualDuration })
          }
          visit(fiber.child)
          visit(fiber.sibling)
        }
        visit(root.current)
        state.commits.push({ sections, sectionDurations, duration: root.current.actualDuration, owners })
      },
      onCommitFiberUnmount: () => {},
    }
  })
  await registerAccount(page)
  const account = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '二十段性能验收', content_format: 'long_article' })
  let work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '段落性能验收' })
  work = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '这是用于段落编辑的人工观点。', base_revision: work.revision })
  await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: Array.from({ length: 20 }, (_, i) => ({ heading: `第${i + 1}段`, key_point: '人工提供的段落要点', material_ids: [] })),
    base_revision: work.revision,
  })
  await page.goto(`/works/${work.id}`)
  await page.getByRole('button', { name: '确认大纲', exact: true }).click()
  await expect(page.locator('#step-sections .tiptap')).toHaveCount(20)
  const outlined = await api(page, 'GET', `/works/${work.id}`)
  for (const section of outlined.sections) await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '这是这一段的人工正文，用于选区和自动保存验收。', base_revision: section.revision })
  const lintResponses = { count: 0 }
  page.on('response', response => {
    if (response.url().endsWith(`/works/${work.id}/lint`) && response.request().method() === 'POST') lintResponses.count++
  })
  await page.reload()
  await expect(page.locator('#step-sections .tiptap')).toHaveCount(20)
  await expect.poll(() => lintResponses.count, { timeout: 15_000 }).toBe(20)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const id = outlined.sections[0].id
  const editor = page.locator(`#sec-${id} .tiptap`)
  await editor.click()
  await page.keyboard.press('Control+Home')
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).outline_confirmed_at).toBeTruthy()
  const start = () => page.evaluate(() => { (window as any).__opt08.commits = []; (window as any).__opt08.record = true })
  const stop = () => page.evaluate(() => { const state = (window as any).__opt08; state.record = false; return state.commits as { sections: string[]; sectionDurations: { id: string; duration: number }[]; duration: number; owners: { name: string; duration: number }[] }[] })
  await start()
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).not.toBe('')
  const selection = await stop()
  await page.getByRole('button', { name: '副驾驶', exact: true }).click()
  await expect(page.getByRole('combobox').filter({ has: page.getByRole('option', { name: '选中的文字', exact: true }) })).toHaveValue('selection')
  await start()
  const saved = page.waitForResponse(r => r.url().endsWith(`/sections/${id}`) && r.request().method() === 'PATCH')
  await editor.fill('自动保存后的人工正文，只能更新当前这一段。')
  expect((await saved).ok()).toBeTruthy()
  await expect(page.getByText(/^已保存 /)).toBeVisible()
  const autosave = await stop()
  const measurements = ([['selection', selection], ['autosave', autosave]] as const).map(([name, commits]) => {
    const updated = [...new Set(commits.flatMap(c => c.sections))]
    const editorDurations = commits.flatMap(c => c.owners.filter(o => o.name === 'ArticleEditor').map(o => o.duration))
    const sectionDurations = commits.flatMap(c => c.sectionDurations.map(s => s.duration))
    const editorMax = Math.max(...editorDurations)
    const sectionMax = Math.max(...sectionDurations)
    const rootMax = Math.max(...commits.map(c => c.duration))
    console.log(`OPT08 ${name}: sections=${updated.length}, ArticleEditor=${editorMax.toFixed(3)}ms, SectionBlock=${sectionMax.toFixed(3)}ms, appRoot=${rootMax.toFixed(3)}ms, commits=${commits.length}`)
    return { updated, max: Math.max(editorMax, sectionMax), editorCount: editorDurations.length, sectionCount: sectionDurations.length }
  })
  for (const { updated, max, editorCount, sectionCount } of measurements) {
    expect(updated).toEqual([id])
    expect(editorCount).toBeGreaterThan(0)
    expect(sectionCount).toBeGreaterThan(0)
    expect(max).toBeLessThan(16)
  }
  const final = await api(page, 'GET', `/works/${work.id}`)
  expect(final.sections[0].content_md).toContain('自动保存后的人工正文')
  expect(final.sections.slice(1).every((s: any) => s.content_md === '这是这一段的人工正文，用于选区和自动保存验收。')).toBeTruthy()
  await page.locator(`#sec-${id}`).getByRole('button', { name: '下移', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).sections[1].id).toBe(id)
  await page.locator(`#sec-${id}`).getByRole('button', { name: '删除段落', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).sections.length).toBe(19)
})
