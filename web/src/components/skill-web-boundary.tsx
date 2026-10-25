import { Card, Notice } from './ui'

export function SkillWebBoundary({ accountId }: { accountId?: string }) {
  const url = new URL(accountId ? `/a/${accountId}/profile?tab=skills` : '/settings/skills', window.location.origin).href
  return <Card className="space-y-3 p-5">
    <h2 className="text-sm font-semibold">请在 Web 管理写作技能</h2>
    <Notice>桌面生成和智能体继续使用已配置的技能；手工填写、导入和账号技能管理请在浏览器中完成。</Notice>
    <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm underline">在浏览器中管理技能</a>
  </Card>
}
