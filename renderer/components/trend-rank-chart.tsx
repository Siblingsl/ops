import { useEffect, useId, useMemo, useRef, useState } from 'react'

interface TrendPoint { at: string; rank: number; source: string }

const COLORS = ['#2f5d62', '#c6861a', '#577fa2', '#956bb1', '#2f7d4f', '#a34d3f']
const HEIGHT = 236
const MARGIN = { top: 20, right: 18, bottom: 30, left: 46 }

interface Series { name: string; color: string; points: { t: number; rank: number }[] }

function niceStep(max: number, target: number) {
  if (max <= 1) return 1
  const raw = max / target
  for (const step of [1, 2, 5, 10, 20, 50, 100]) if (step >= raw) return step
  return Math.ceil(raw)
}

const two = (n: number) => String(n).padStart(2, '0')

function clock(ms: number, withDate: boolean) {
  const d = new Date(ms)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return withDate ? `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}` : hm
}

/** 按容器实际像素布局，避免 viewBox 缩放把刻度文字一起缩小。 */
function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setWidth(Math.round(node.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/**
 * 热榜排名变化图：纵轴名次（越靠上越前），横轴时间，来源分色。
 * 只连接实际采样点，不把采样缺口当成连续在榜；悬浮某点可看名次与较上次变化。
 */
export function TrendRankChart({ title, points }: { title: string; points: TrendPoint[] }) {
  const [boxRef, width] = useContainerWidth()
  const gradientId = `trend-wash-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [hover, setHover] = useState<{ name: string; index: number; x: number; y: number } | null>(null)
  const [legendHover, setLegendHover] = useState('')
  const [pinned, setPinned] = useState('')

  const model = useMemo(() => {
    const bySource = new Map<string, { t: number; rank: number }[]>()
    for (const point of points) {
      const t = new Date(point.at).getTime()
      if (!Number.isFinite(t)) continue
      const list = bySource.get(point.source) ?? []
      const same = list.find((item) => item.t === t)
      if (same) same.rank = Math.min(same.rank, point.rank)
      else list.push({ t, rank: point.rank })
      bySource.set(point.source, list)
    }
    const series: Series[] = [...bySource.entries()]
      .map(([name, list]) => ({ name, points: list.sort((a, b) => a.t - b.t) }))
      .sort((a, b) => a.points[0].t - b.points[0].t)
      .map((item, index) => ({ ...item, color: COLORS[index % COLORS.length] }))
    const all = series.flatMap((item) => item.points)
    if (!all.length) return null
    let t0 = Math.min(...all.map((item) => item.t))
    let t1 = Math.max(...all.map((item) => item.t))
    if (t0 === t1) { t0 -= 30 * 60_000; t1 += 30 * 60_000 }
    const maxRank = Math.max(1, ...all.map((item) => item.rank))
    const step = maxRank <= 6 ? 1 : niceStep(maxRank, 5)
    const rankTicks: number[] = [1]
    for (let rank = step === 1 ? 2 : step; rank <= maxRank; rank += step) rankTicks.push(rank)
    if (!rankTicks.includes(maxRank)) rankTicks.push(maxRank)
    return { series, t0, t1, maxRank, rankTicks, timeCount: new Set(all.map((item) => item.t)).size }
  }, [points])

  if (!model) return null

  const { series, t0, t1, maxRank, rankTicks, timeCount } = model
  const plotW = Math.max(160, width - MARGIN.left - MARGIN.right)
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom
  const x = (t: number) => MARGIN.left + ((t - t0) / (t1 - t0)) * plotW
  const y = (rank: number) => MARGIN.top + (maxRank === 1 ? plotH / 2 : ((rank - 1) / (maxRank - 1)) * plotH)
  const withDate = t1 - t0 > 36 * 3600_000
  const active = hover?.name || legendHover || pinned
  const hoverSeries = hover ? series.find((item) => item.name === hover.name) : undefined
  const hoverPoint = hover && hoverSeries ? hoverSeries.points[hover.index] : undefined
  const hoverPrev = hover && hoverSeries && hover.index > 0 ? hoverSeries.points[hover.index - 1] : undefined
  const tooltipLeft = hover ? Math.min(Math.max(hover.x, 104), Math.max(104, width - 104)) : 0
  const tooltipTop = hover ? (hover.y < 66 ? hover.y + 14 : hover.y - 14) : 0
  const timeTickCount = plotW >= 520 ? 5 : plotW >= 320 ? 3 : 2
  const timeTicks = Array.from({ length: timeTickCount }, (_, index) => t0 + ((t1 - t0) * index) / (timeTickCount - 1))
  const sampleDots = series.reduce((sum, item) => sum + item.points.length, 0) <= 36
  const label = `「${title}」排名变化。${series.map((item) => {
    const last = item.points[item.points.length - 1]
    return `${item.name} 当前第 ${last.rank} 名`
  }).join('；')}。纵轴越靠上排名越前，圆点是实际采样点。`

  return (
    <figure className="mt-1" aria-label={`${title}排名变化`}>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {series.map((item) => {
          const last = item.points[item.points.length - 1]
          const prev = item.points.length > 1 ? item.points[item.points.length - 2] : undefined
          const delta = prev ? prev.rank - last.rank : 0
          const on = active === item.name
          return (
            <button
              key={item.name}
              type="button"
              aria-pressed={pinned === item.name}
              className={`group inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[12px] transition ${on ? 'bg-mist-100 text-mist-800' : 'text-mist-600 hover:bg-mist-50 hover:text-mist-800'}`}
              title={`固定查看「${item.name}」`}
              onMouseEnter={() => { setHover(null); setLegendHover(item.name) }}
              onMouseLeave={() => setLegendHover('')}
              onClick={() => setPinned((current) => current === item.name ? '' : item.name)}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: item.color }} />
              <span className="max-w-40 truncate">{item.name}</span>
              <span className="tabular-nums text-mist-500">第 {last.rank}</span>
              {delta > 0 && <span className="tabular-nums text-success">↑{delta}</span>}
              {delta < 0 && <span className="tabular-nums text-danger">↓{-delta}</span>}
            </button>
          )
        })}
        {pinned && <button type="button" className="text-[11.5px] text-mist-400 underline-offset-2 hover:text-mist-600 hover:underline" onClick={() => setPinned('')}>取消固定</button>}
      </div>

      <div ref={boxRef} className="relative w-full" style={{ minHeight: HEIGHT }}>
        {width > 0 && (
          <>
            <svg width={width} height={HEIGHT} role="img" aria-label={label} className="block overflow-visible">
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f4f9f9" />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                </linearGradient>
              </defs>
              <rect x={MARGIN.left} y={MARGIN.top} width={plotW} height={plotH} rx={8} fill={`url(#${gradientId})`} />
              <text x={4} y={12} className="fill-mist-400" fontSize={10}>名次</text>

              {rankTicks.map((rank) => (
                <g key={`rank-${rank}`}>
                  <line x1={MARGIN.left} y1={y(rank)} x2={MARGIN.left + plotW} y2={y(rank)} stroke="#e1e5e8" strokeDasharray={rank === 1 ? undefined : '2 4'} />
                  <text x={MARGIN.left - 10} y={y(rank) + 3.5} textAnchor="end" fontSize={10.5} className="fill-mist-500 tabular-nums">{rank}</text>
                </g>
              ))}

              {timeTicks.map((t, index) => (
                <g key={`time-${index}`}>
                  {index > 0 && index < timeTicks.length - 1 && (
                    <line x1={x(t)} y1={MARGIN.top} x2={x(t)} y2={MARGIN.top + plotH} stroke="#eef0f2" strokeDasharray="2 5" />
                  )}
                  <text
                    x={index === 0 ? MARGIN.left : index === timeTicks.length - 1 ? MARGIN.left + plotW : x(t)}
                    y={HEIGHT - 9}
                    textAnchor={index === 0 ? 'start' : index === timeTicks.length - 1 ? 'end' : 'middle'}
                    fontSize={10.5}
                    className="fill-mist-400 tabular-nums"
                  >{clock(t, withDate)}</text>
                </g>
              ))}

              {hover && (
                <line x1={hover.x} y1={MARGIN.top} x2={hover.x} y2={MARGIN.top + plotH} stroke="#bcd3d5" strokeDasharray="3 4" />
              )}

              {series.map((item) => {
                const dim = active && active !== item.name
                const path = item.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)} ${y(point.rank).toFixed(1)}`).join(' ')
                const last = item.points[item.points.length - 1]
                return (
                  <g key={`line-${item.name}`} style={{ opacity: dim ? 0.25 : 1, transition: 'opacity 180ms ease' }}>
                    {item.points.length > 1 && (
                      <path
                        key={`path-${item.name}-${item.points.length}-${last.t}-${last.rank}`}
                        d={path}
                        fill="none"
                        pathLength={1}
                        stroke={item.color}
                        strokeWidth={active === item.name ? 2.8 : 2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="trend-rank-line"
                        style={{ transition: 'stroke-width 180ms ease, opacity 180ms ease' }}
                      />
                    )}
                    {sampleDots && item.points.slice(0, -1).map((point, index) => (
                      <circle
                        key={`dot-${item.name}-${index}`}
                        cx={x(point.t)}
                        cy={y(point.rank)}
                        r={2.4}
                        fill={item.color}
                        opacity={0.55}
                        className="trend-rank-dot"
                        style={{ animationDelay: `${Math.min(600, index * 36)}ms` }}
                      />
                    ))}
                    <circle cx={x(last.t)} cy={y(last.rank)} r={6} fill="#ffffff" stroke={item.color} strokeWidth={1.5} opacity={0.9} className="trend-rank-dot" style={{ animationDelay: '620ms' }} />
                    <circle cx={x(last.t)} cy={y(last.rank)} r={3} fill={item.color} className="trend-rank-dot" style={{ animationDelay: '640ms' }} />
                  </g>
                )
              })}

              {series.map((item) => item.points.map((point, index) => (
                <circle
                  key={`hit-${item.name}-${index}`}
                  cx={x(point.t)}
                  cy={y(point.rank)}
                  r={8}
                  fill="transparent"
                  className="cursor-crosshair"
                  onMouseEnter={() => setHover({ name: item.name, index, x: x(point.t), y: y(point.rank) })}
                  onMouseLeave={() => setHover(null)}
                />
              )))}
            </svg>

            {hover && hoverSeries && hoverPoint && (
              <div
                className="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-mist-200 bg-white/95 px-2.5 py-1.5 text-[11.5px] shadow-pop"
                style={{ left: tooltipLeft, top: tooltipTop, transform: hover.y < 66 ? 'translate(-50%, 0)' : 'translate(-50%, -100%)' }}
              >
                <div className="flex items-center gap-1.5 font-medium text-mist-800">
                  <span className="size-2 rounded-full" style={{ background: hoverSeries.color }} />
                  <span className="max-w-44 truncate">{hoverSeries.name}</span>
                </div>
                <div className="mt-0.5 tabular-nums text-mist-600">第 {hoverPoint.rank} 名 · {clock(hoverPoint.t, withDate)}</div>
                <div className="mt-0.5 tabular-nums text-mist-500">
                  {!hoverPrev ? '首个采样点'
                    : hoverPrev.rank > hoverPoint.rank ? `较上次上升 ${hoverPrev.rank - hoverPoint.rank} 位`
                      : hoverPrev.rank < hoverPoint.rank ? `较上次下降 ${hoverPoint.rank - hoverPrev.rank} 位`
                        : '与上次持平'}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <figcaption className="mt-1 text-[11.5px] leading-5 text-mist-500">
        纵轴为名次，越靠上排名越前；圆点是实际采样，线只连接已观测到的名次。
        {timeCount < 3 && ` 采样点还少（${timeCount} 个时间点），曲线会随采集补全。`}
      </figcaption>
    </figure>
  )
}
