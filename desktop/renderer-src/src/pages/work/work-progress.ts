import type { Work } from '@/lib/types'

/**
 * ED-05：作品进度只有一套语义。
 *
 * 过去编辑器左栏「创作步骤」按内容推断进度，页头流程条按状态机展示发布进度，
 * 两套名称、粒度、完成判定都不同，用户看到两个进度体系，不知道当前卡在哪一步。
 *
 * 这里把两者的判定收敛到一个模块：
 * - `creationSteps`：内容进度（观点 → 大纲 → 分段起稿 → 标题 → 配图），只看内容是否就绪；
 * - `publishSteps`：发布进度（创作 → 对照改写 → 排版预览 → 发布前检查 → 写入/发布包），只看状态机。
 * 两套进度各自标注语义（左栏「内容进度」、页头「发布进度」），且共用同一份完成判定：
 * 内容没写完时流程条停在「创作」，内容写完进入检查后才推进到后面的发布项。
 */

export interface StepState {
  id: string
  label: string
  done: boolean
  extra?: string
}

export function creationSteps(work: Work, internalNameOnly: boolean): StepState[] {
  const toutiao = work.platform === 'toutiao'
  // NW-B4：微头条不发布标题，内部名称不应成为第 4 步的完成条件。
  const titleDone = internalNameOnly || !!work.title.trim()
  const imagesDone = work.platform === 'wechat_mp' ? !!work.cover_asset_id : toutiao || work.assets.length > 0
  const drafted = work.sections.filter((s) => s.content_md.trim()).length
  return [
    { id: 'step-viewpoint', label: '核心观点', done: !!work.viewpoint.trim() },
    { id: 'step-outline', label: '大纲', done: !!work.outline_confirmed_at },
    {
      id: 'step-sections', label: '分段起稿',
      done: work.sections.length > 0 && drafted === work.sections.length,
      extra: work.sections.length ? `${drafted}/${work.sections.length}` : '',
    },
    { id: 'step-title', label: work.platform === 'wechat_mp' ? '标题与摘要' : internalNameOnly ? '内部名称与话题（可选）' : toutiao ? '发布标题与话题' : '标题与话题', done: titleDone },
    { id: 'step-images', label: work.platform === 'wechat_mp' ? '配图与封面' : toutiao ? '配图（可选）' : '笔记图片', done: imagesDone },
  ]
}

/** 内容进度全部就绪才进入发布阶段；未就绪时返回第一个未完成步骤 id。 */
export function activeCreationStep(steps: StepState[]): string {
  return steps.find((s) => !s.done)?.id ?? steps[steps.length - 1].id
}

export function creationProgress(steps: StepState[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.done).length, total: steps.length }
}

/** 内容是否已足够进入发布阶段（观点、大纲、正文、标题、配图都就绪）。 */
export function contentReady(steps: StepState[]): boolean {
  return steps.every((s) => s.done)
}
