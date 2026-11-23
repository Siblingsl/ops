// B-12：演示录制与扩展冲突驱逐（纯函数，不直接接触页面 DOM）。
//
// 对齐 `docs/41-browse可借鉴实现清单.md` §12.1/§12.2：
//   * 只在 agent `running` 时驱逐密码管理器等外部扩展 frame；`attached/waiting` 保留；
//   * 录制语义步骤而不是原始事件：点击找最近可操作元素，selector 优先 id →
//     data-testid/data-test/name/aria-label（必须唯一）→ 逐级 tag:nth-of-type(n)；
//   * 记录 role 与 name；password 输入值置空并标 redacted；
//   * 步骤立即入队（调用方 drain），不依赖页面导航后仍存活。
//
// OPS 当前走 content script 注入，不需要 `chrome.debugger`，因此驱逐是“若 B-02B 走
// debugger 才启用”的策略库；演示录制只用于开发期生成适配器常量，运行时不执行录制产物。

export type PageState = 'attached' | 'running' | 'waiting' | 'recording';

export interface DemoElement {
  tagName: string;
  id?: string;
  attributes?: Record<string, string>;
  textContent?: string;
  children?: DemoElement[];
  parent?: DemoElement | null;
  shadowRoot?: DemoElement | null;
}

export interface DemoStep {
  kind: 'click' | 'fill';
  selector: string;
  role?: string;
  name?: string;
  value?: string;
  redacted?: boolean;
}

const ACTIONABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const ACTIONABLE_ROLES = new Set(['button', 'link', 'tab', 'menuitem']);

function tagOf(element: DemoElement): string {
  return String(element.tagName || '').toUpperCase();
}

function attrsOf(element: DemoElement): Record<string, string> {
  return element.attributes ?? {};
}

function childElements(element: DemoElement): DemoElement[] {
  return element.children ?? [];
}

/** 递归进入 open shadow root；closed shadow root 只靠宿主元素的扩展特征识别。 */
function* walk(element: DemoElement): Generator<DemoElement> {
  yield element;
  for (const child of childElements(element)) yield* walk(child);
  if (element.shadowRoot) yield* walk(element.shadowRoot);
}

function countMatches(root: DemoElement, predicate: (el: DemoElement) => boolean): number {
  let count = 0;
  for (const el of walk(root)) if (predicate(el)) count += 1;
  return count;
}

function cssEscape(value: string): string {
  return String(value).replace(/["\\]/g, '\\$&');
}

/** selector 优先序：id → 唯一 data-testid/data-test/name/aria-label → 逐级 nth-of-type。 */
export function buildSelector(element: DemoElement, root: DemoElement): string {
  const id = element.id;
  if (id) {
    const selector = `#${cssEscape(id)}`;
    if (countMatches(root, (el) => el.id === id) === 1) return selector;
  }
  for (const name of ['data-testid', 'data-test', 'name', 'aria-label']) {
    const value = attrsOf(element)[name];
    if (!value) continue;
    const selector = `[${name}="${cssEscape(value)}"]`;
    if (countMatches(root, (el) => attrsOf(el)[name] === value) === 1) return selector;
  }
  const segments: string[] = [];
  let current: DemoElement | null = element;
  while (current && current !== root) {
    const node: DemoElement = current;
    const tag = tagOf(node).toLowerCase();
    const parent: DemoElement | null = node.parent ?? null;
    if (!parent) {
      segments.unshift(tag);
      break;
    }
    const siblings = childElements(parent).filter((el) => tagOf(el) === tagOf(node));
    const index = siblings.indexOf(node) + 1;
    segments.unshift(`${tag}:nth-of-type(${index})`);
    current = parent;
  }
  return segments.join(' > ');
}

export function roleOf(element: DemoElement): string {
  const explicit = attrsOf(element).role;
  if (explicit) return explicit;
  const tag = tagOf(element);
  if (tag === 'A') return 'link';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'SUMMARY') return 'menuitem';
  return tag.toLowerCase();
}

export function nameOf(element: DemoElement, root: DemoElement): string {
  const attrs = attrsOf(element);
  if (attrs['aria-label']) return attrs['aria-label'].slice(0, 120);
  const labelledBy = attrs['aria-labelledby'];
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).filter(Boolean).map((id) => {
      for (const el of walk(root)) if (el.id === id) return (el.textContent || '').trim();
      return '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ').slice(0, 120);
  }
  return (element.textContent || '').trim().slice(0, 120);
}

function isActionable(element: DemoElement): boolean {
  const tag = tagOf(element);
  if (tag === 'A') return Boolean(attrsOf(element).href);
  if (ACTIONABLE_TAGS.has(tag)) return true;
  return ACTIONABLE_ROLES.has(attrsOf(element).role || '');
}

/** 从 composedPath 找最近的可操作元素；找不到时回退到最近的有文本元素（菜单项常是 span/div）。 */
export function nearestActionable(path: DemoElement[]): DemoElement | null {
  for (const element of path) {
    if (isActionable(element)) return element;
  }
  for (const element of path) {
    const tag = tagOf(element);
    if (tag === 'BODY' || tag === 'HTML') continue;
    if ((element.textContent || '').trim()) return element;
  }
  return null;
}

export function recordClick(composedPath: DemoElement[], root: DemoElement): DemoStep | null {
  const target = nearestActionable(composedPath);
  if (!target) return null;
  return {
    kind: 'click',
    selector: buildSelector(target, root),
    role: roleOf(target),
    name: nameOf(target, root),
  };
}

/** 输入生成 fill；password 值置空并标 redacted。 */
export function recordInput(element: DemoElement, value: string, root: DemoElement): DemoStep {
  const type = String(attrsOf(element).type || '').toLowerCase();
  if (type === 'password') {
    return { kind: 'fill', selector: buildSelector(element, root), redacted: true };
  }
  return { kind: 'fill', selector: buildSelector(element, root), value: String(value).slice(0, 500) };
}

/** 步骤立即入队；调用方每一步后 drain，避免导航丢掉未返回步骤。 */
export class DemoRecorder {
  private steps: DemoStep[] = [];

  record(step: DemoStep | null): boolean {
    if (!step) return false;
    this.steps.push(step);
    return true;
  }

  drain(): DemoStep[] {
    const out = this.steps;
    this.steps = [];
    return out;
  }

  size(): number {
    return this.steps.length;
  }
}

/** 只有 agent `running` 时驱逐外部扩展 frame；attached/waiting/recording 保留。 */
export function shouldEvictForeignFrames(state: PageState): boolean {
  return state === 'running';
}

export interface ForeignFrameResult {
  foreign: boolean;
  reason?: string;
}

export function isForeignFrame(element: DemoElement, ownExtensionId: string): ForeignFrameResult {
  const tag = tagOf(element);
  const attrs = attrsOf(element);
  if (tag.startsWith('COM-1PASSWORD-')) return { foreign: true, reason: '1password_tag' };
  if ('data-onepassword-extension' in attrs) return { foreign: true, reason: '1password_attr' };
  if ('data-lastpass-root' in attrs) return { foreign: true, reason: 'lastpass_attr' };
  if ((element.id || '').startsWith('bitwarden-')) return { foreign: true, reason: 'bitwarden_id' };
  if (['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(tag)) {
    const src = attrs.src || attrs.data || '';
    if (src.startsWith('chrome-extension://')) {
      const id = src.slice('chrome-extension://'.length).split('/')[0];
      if (id && id !== ownExtensionId) return { foreign: true, reason: 'foreign_extension_src' };
    }
  }
  return { foreign: false };
}

/** 递归（含 open shadow root）移除外部扩展宿主；返回移除原因列表。 */
export function evictForeignFrames(root: DemoElement, ownExtensionId: string): string[] {
  const removed: string[] = [];
  for (const element of Array.from(walk(root))) {
    const result = isForeignFrame(element, ownExtensionId);
    if (!result.foreign) continue;
    const parent = element.parent;
    if (parent && Array.isArray(parent.children)) {
      const index = parent.children.indexOf(element);
      if (index >= 0) parent.children.splice(index, 1);
    }
    removed.push(result.reason || 'foreign');
  }
  return removed;
}
