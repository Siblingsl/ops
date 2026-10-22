import { isElectronDesktop } from '@/lib/desktop-presentation.js'

const menus = [
  ['客户端', 'client'],
  ['编辑', 'edit'],
  ['视图', 'view'],
] as const

export default function DesktopTitlebar() {
  if (!isElectronDesktop(navigator.userAgent)) return null

  return (
    <header className="desktop-titlebar" aria-label="OPS 应用标题栏">
      <nav className="desktop-titlebar-menus" aria-label="应用菜单">
        {menus.map(([label, menu]) => <a key={menu} href={`ops-desktop://ui/menu/${menu}`} target="_blank" rel="noreferrer">{label}</a>)}
      </nav>
    </header>
  )
}
