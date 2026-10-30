import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

const menus = [
  ['客户端', 'client'],
  ['编辑', 'edit'],
  ['视图', 'view'],
] as const

export default function DesktopTitlebar() {
  const navigate = useNavigate()
  if (!isElectronDesktop(navigator.userAgent)) return null

  return (
    <header className="desktop-titlebar" aria-label="OPS 应用标题栏">
      <div className="desktop-titlebar-navigation">
        <button type="button" className="desktop-nav-back" aria-label="返回上一视图" title="返回" onClick={() => navigate(-1)}><ChevronLeft aria-hidden="true" /></button>
        <button type="button" className="desktop-nav-forward" aria-label="前进到下一视图" title="前进" onClick={() => navigate(1)}><ChevronRight aria-hidden="true" /></button>
      </div>
      <nav className="desktop-titlebar-menus" aria-label="应用菜单">
        {menus.map(([label, menu]) => <a key={menu} href={`ops-desktop://ui/menu/${menu}`} target="_blank" rel="noreferrer">{label}</a>)}
      </nav>
    </header>
  )
}
