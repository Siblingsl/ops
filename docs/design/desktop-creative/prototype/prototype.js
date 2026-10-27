'use strict';

// 方案 B 独立设计原型：只操作示例数据，不调用业务 API、Electron IPC 或模型。
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z M9 21v-8h6v8',
  file:'M14 3H5v18h14V8Z M14 3v5h5 M8 12h8 M8 16h6',
  idea:'M9 18h6 M10 21h4 M8 14a6 6 0 1 1 8 0l-1 2H9Z',
  calendar:'M4 5h16v16H4Z M8 3v4 M16 3v4 M4 10h16 M8 14h2 M14 14h2 M8 17h2',
  book:'M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Z M12 5v15',
  image:'M3 4h18v16H3Z M3 16l6-6 5 5 3-3 4 4 M15 8h.01',
  chart:'M4 3v17h17 M8 15v-4 M13 15V7 M18 15v-6',
  activity:'M3 12h4l3-7 4 14 3-7h4',
  user:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3',
  bot:'M5 7h14v13H5Z M12 3v4 M2 11v5 M22 11v5 M9 12h.01 M15 12h.01 M9 16h6',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2',
  search:'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6',
  bell:'M5 16h14l-2-3V9a5 5 0 0 0-10 0v4Z M10 20h4',
  panel:'M3 4h18v16H3Z M9 4v16',
  back:'M15 5l-7 7 7 7',
  arrow:'M5 12h14 M13 6l6 6-6 6',
  plus:'M12 5v14 M5 12h14',
  check:'M5 12l4 4L19 6',
  clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
  spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  moon:'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z',
  sun:'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
  close:'M6 6l12 12 M18 6 6 18',
  paperclip:'M8 13l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8 M7 14l7-7',
  shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z M8 12l3 3 5-6',
  download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  folder:'M3 6h7l2 2h9v12H3Z',
  expand:'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',
  link:'M10 14l4-4 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  inbox:'M5 4h14l3 12v4H2v-4Z M3 15h5l2 3h4l2-3h5',
  more:'M5 12h.01 M12 12h.01 M19 12h.01',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
const button = (text, action, kind = '', extra = '') => `<button class="button ${kind}" data-action="${action}" ${extra}>${text}</button>`;
const badge = (text, tone = '') => `<span class="tag ${tone}">${text}</span>`;
const navs = [
  ['创作', [['home','home','工作台'],['works','file','作品','12'],['topics','idea','选题池','8'],['calendar','calendar','内容日历']]],
  ['资源', [['materials','book','素材库'],['images','image','图片库']]],
  ['运营', [['ops','activity','账号运营'],['review','chart','数据复盘'],['profile','user','账号档案']]],
];
const pageInfo = Object.fromEntries(navs.flatMap(([group, entries]) => entries.map(([id, glyph, label]) => [id,{group,glyph,label}])));
Object.assign(pageInfo,{editor:{group:'作品',label:'创作编辑器'},agent:{group:'工作区',label:'AI 对话'},settings:{group:'工作区',label:'工作区设置'},search:{group:'工作区',label:'搜索'},share:{group:'收集',label:'保存分享'},login:{group:'账号',label:'登录'},register:{group:'账号',label:'注册'},setup:{group:'账号',label:'首次初始化'},public:{group:'预览',label:'公开预览示意'}});
const state = {page:'home', history:[], account:'wx', theme:'light', reduced:false, workFilter:'全部', query:'', workTab:'编辑', tool:'素材', shape:'article', focus:false, section:0, checkDone:new Set(), checkChoices:{}, cards:new Set(), agentMessages:[], busy:false, localTab:'连接与模式', settingTab:'偏好设置', mode:'server', channel:false, modelSaved:false, tested:false, draftMap:false, appliedMap:false, topicTab:'待定', opsTab:'运营方案', profileTab:'定位', status:'online', editorText:null, collect:[], star:new Set([0]), selectedDate:null};
const workTitle = '把时间留给真正重要的事';
const works = [
  {title:workTitle, desc:'时间管理 · 系列「慢一点，也没关系」', status:'创作中',tone:'blue', date:'今天 10:24',plan:'10 月 18 日',tags:'时间管理'},
  {title:'为什么我们需要一点「无用」的时间',desc:'生活观察 · 长图文',status:'待审阅',tone:'amber',date:'昨天 18:42',plan:'10 月 17 日',tags:'生活观察'},
  {title:'一份适合普通人的周末重启清单',desc:'效率习惯 · 长图文',status:'可发布',tone:'green',date:'10 月 14 日',plan:'10 月 16 日',tags:'效率习惯'},
  {title:'先做减法，再谈自律',desc:'时间管理 · 长图文',status:'已进草稿箱',tone:'',date:'10 月 12 日',plan:'10 月 13 日',tags:'时间管理'},
  {title:'重新认识你的注意力',desc:'生活观察 · 长图文',status:'已发布',tone:'',date:'10 月 10 日',plan:'10 月 11 日',tags:'生活观察'},
];
const baseParagraphs = ['我们总是习惯把日程填满，仿佛每一段空白都需要一个解释。可当一天结束，真正让人记住的，往往并不是完成了多少项待办。','上周，我试着把每天最清醒的一小时留给写作。没有打开消息列表，也没有先处理那些看上去紧急的小事。变化比我预想得更简单：我开始重新拥有一段完整的思考。','安排时间之前，也许可以先问自己：这件事，真的值得占据今天吗？'];
let modalTrigger = null, toastTimer = 0, saveTimer = 0, streamTimer = 0, gPending = 0;
try { state.theme = localStorage.getItem('ops-creative-prototype-theme') || 'light'; state.reduced = localStorage.getItem('ops-creative-prototype-motion') === 'reduce'; } catch {}

function applyPreferences() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.reducedMotion = String(state.reduced);
  $('#theme-toggle').innerHTML = icon(state.theme === 'light' ? 'moon' : 'sun');
  $('#theme-toggle').setAttribute('aria-label',state.theme === 'light' ? '切换到深色主题' : '切换到浅色主题');
  $('#motion-toggle').textContent = state.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches ? '减少动态效果' : '轻快动效';
  try { localStorage.setItem('ops-creative-prototype-theme',state.theme); localStorage.setItem('ops-creative-prototype-motion',state.reduced ? 'reduce' : 'soft'); } catch {}
}
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; },6500);
}
function navigate(page, options = {}) {
  if (!pageInfo[page]) return;
  if (!options.back && page !== state.page) state.history.push(state.page);
  state.page = page;
  if ($('#modal').open) $('#modal').close();
  render(); $('#view').scrollTop = 0; $('#view').focus({preventScroll:true});
}
function navEntry(id,glyph,label,count) { return `<button class="nav-item ${state.page === id ? 'active' : ''}" data-nav="${id}" ${state.page === id ? 'aria-current="page"' : ''} title="${label}">${icon(glyph)}<span class="nav-text">${label}</span>${count ? `<span class="count">${count}</span>` : ''}</button>`; }
function renderSidebar() {
  $('#sidebar-main').innerHTML = navs.map(([label,entries]) => `<div class="nav-group" aria-label="${label}">${entries.map(entry => navEntry(...entry)).join('')}</div>`).join('');
  $('#sidebar-bottom').innerHTML = navEntry('agent','bot','AI 对话') + `<button class="nav-item ${state.page === 'settings' ? 'active' : ''}" data-action="workspace-settings" title="工作区设置">${icon('settings')}<span class="nav-text">设置</span></button>`;
}
function pageTop(title, desc, actions = '') { return `<div class="page-top"><div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`; }
function workRows(limit) {
  const filtered = works.map((work,index) => ({...work,index})).filter(work => (state.workFilter === '全部' || work.status === state.workFilter || (state.workFilter === '检查中' && work.status === '待审阅')) && (!state.query || (work.title+work.tags).includes(state.query)));
  return `<div class="table-wrap"><table class="work-table"><thead><tr><th style="width:30px"></th><th>作品名称</th><th>状态</th><th>计划发布</th><th>最近修改</th><th></th></tr></thead><tbody>${filtered.slice(0,limit || 99).map(work => `<tr><td><button class="star ${state.star.has(work.index) ? 'on' : ''}" data-star="${work.index}" aria-label="${state.star.has(work.index) ? '取消星标' : '添加星标'}">${state.star.has(work.index) ? '★' : '☆'}</button></td><td><button class="work-title" data-nav="editor">${icon('file')}<span>${work.title}<small>${work.desc}</small></span></button></td><td>${badge(work.status,work.tone)}</td><td class="muted">${work.plan}</td><td class="muted">${work.date}</td><td><button class="icon-button" data-action="work-more" aria-label="作品更多操作">${icon('more')}</button></td></tr>`).join('')}</tbody></table>${filtered.length ? '' : '<div class="empty">没有符合条件的作品，请尝试其他筛选。</div>'}</div>`;
}
function homeView() {
  const accountName = state.account === 'wx' ? '知行笔记' : '知行日常';
  const illustration = `<div class="creative-illustration" aria-hidden="true"><svg viewBox="0 0 270 240" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="135" cy="124" r="93" fill="#DED1F4"/>
    <circle cx="135" cy="124" r="73" stroke="#CDBCE8" stroke-width="1" stroke-dasharray="3 7"/>
    <g class="paper-object back"><g transform="rotate(-16 105 125)"><rect x="48" y="47" width="108" height="151" rx="12" fill="#BEABD8"/><rect x="42" y="42" width="108" height="151" rx="12" fill="#FFF9F0"/><rect x="58" y="60" width="40" height="7" rx="3.5" fill="#EDBC9A"/><rect x="58" y="83" width="73" height="4" rx="2" fill="#E2D8CB"/><rect x="58" y="95" width="60" height="4" rx="2" fill="#E2D8CB"/><rect x="58" y="107" width="67" height="4" rx="2" fill="#E2D8CB"/><rect x="58" y="142" width="73" height="26" rx="6" fill="#F6E8D9"/></g></g>
    <g class="paper-object front"><g transform="rotate(11 166 142)"><rect x="113" y="75" width="111" height="141" rx="13" fill="#B7A0D8"/><rect x="107" y="69" width="111" height="141" rx="13" fill="#FFFFFF"/><rect x="123" y="84" width="79" height="61" rx="8" fill="#E1EEE7"/><path d="M160 97c15-14 30 2 10 16 22 1 22 22 1 20 2 21-19 21-20 1-17 13-31-3-12-17-22-2-20-22 1-20-2-20 20-22 20 0Z" fill="#A9C6B3"/><circle cx="157" cy="116" r="9" fill="#F7FAEE"/><rect x="123" y="160" width="63" height="5" rx="2.5" fill="#9580B4"/><rect x="123" y="173" width="78" height="4" rx="2" fill="#E3DDED"/><rect x="123" y="184" width="50" height="4" rx="2" fill="#E3DDED"/></g></g>
    <g class="spark-object"><path d="m204 21 5.8 17.2L227 44l-17.2 5.8L204 67l-5.8-17.2L181 44l17.2-5.8L204 21Z" fill="#8E70BD"/><circle cx="234" cy="91" r="5" fill="#F5E7CC"/><path d="m35 164 4.2 10.8L50 179l-10.8 4.2L35 194l-4.2-10.8L20 179l10.8-4.2L35 164Z" fill="#AC90D0"/></g>
    <path d="m56 209 30 6 M57 214l17 3" stroke="#B5A1CF" stroke-width="2" stroke-linecap="round"/>
  </svg></div>`;
  return `<div class="page creative-page">
    <div class="creative-welcome"><div><h1>今天，给灵感一点空间。</h1><p>${accountName} · 从一个小想法，到一篇有温度的内容。</p></div><div class="actions"><span class="date-pill">${icon('calendar')} 10 月 16 日，星期五</span>${button(icon('plus')+' 新建作品','new-work','primary')}</div></div>
    <div class="creative-main-grid"><div class="creative-left">
      <article class="creation-feature"><div class="feature-copy"><div class="feature-kicker">${icon('file')} 你的创作进行时 ${badge('分段写作')}</div><h2>${workTitle}</h2><p>不必急着完成，先写下今天最想表达的。<br>这篇内容已经有了清晰的大纲，继续把真实经历放进去。</p><div class="feature-footer">${button('继续这篇作品 '+icon('arrow'),'continue','primary')}<small>已完成 2 / 5 步 · 上次编辑 10:24</small></div></div>${illustration}</article>
      <div class="journey-row"><button class="journey-card lilac" data-nav="topics"><span class="journey-icon">${icon('idea')}</span><span class="journey-value">8<small>个</small></span><strong>让想法长成选题</strong><span class="arrow">${icon('arrow')}</span></button><button class="journey-card peach" data-nav="works"><span class="journey-icon">${icon('file')}</span><span class="journey-value">5<small>篇</small></span><strong>正在慢慢写好的内容</strong><span class="arrow">${icon('arrow')}</span></button><button class="journey-card mint" data-action="go-check"><span class="journey-icon">${icon('shield')}</span><span class="journey-value">1<small>篇</small></span><strong>发布前，再看一遍</strong><span class="arrow">${icon('arrow')}</span></button></div>
      <section class="creative-section"><div class="section-heading"><h2>最近打开</h2><button class="text-button" data-nav="works">全部作品 ${icon('arrow')}</button></div><div class="recent-tiles">${works.slice(0,3).map((work,i) => `<button class="recent-tile" data-nav="editor"><div class="tile-art">${i===0?'<span class="mini-document"><i></i><i></i><i></i><i></i></span>':i===1?'<span class="mini-flower"></span>':'<span class="mini-lines"><i></i><i></i><i></i></span>'}</div>${badge(work.status,work.tone)}<h3>${work.title}</h3><div class="tile-bottom"><span>${work.date}</span><span>${icon('file')} 长图文</span></div></button>`).join('')}</div></section>
      <div class="inspiration-strip"><article class="inspiration-note"><span class="note-icon">${icon('inbox')}</span><div class="note-copy"><strong>灵感先放这里</strong><p>散步时的想法、看到的一句话，先收好，之后再逐条整理。</p><button class="text-button" data-action="collect">记下一条灵感 ＋</button><button class="text-button" data-action="creative-inbox" style="margin-left:13px">查看收件箱</button></div></article><article class="inspiration-note"><span class="note-icon" style="background:var(--mint);color:var(--mint-ink)">${icon('spark')}</span><div class="note-copy"><strong>今天的内容参考</strong><p>从一个真实生活场景开始，读者更容易读到你自己的声音。</p><button class="text-button" data-action="creative-daily">查看每日推荐 ${icon('arrow')}</button></div></article></div>
    </div><aside class="creative-right">
      <section class="today-panel"><div class="section-heading"><h2>今天的安排</h2><span class="day-date">3 件小事</span></div><button class="creative-todo" data-action="review-work"><span class="todo-indicator"></span><span><strong>看看一篇待审阅的作品</strong><small>为什么我们需要一点「无用」的时间</small></span></button><button class="creative-todo" data-action="backfill"><span class="todo-indicator"></span><span><strong>补上 2 篇内容的发布链接</strong><small>让这次创作，连上下一次复盘</small></span></button><button class="creative-todo" data-action="creative-inbox"><span class="todo-indicator"></span><span><strong>整理一条最近收集的灵感</strong><small>把经历留下，让想法慢慢生长</small></span></button><div class="week-progress"><div class="meta"><strong style="color:var(--text)">本周节奏</strong><span>2 / 3 篇已完成</span></div><div class="week-dots">${['一','二','三','四','五','六','日'].map((d,i)=>`<span class="${[1,3].includes(i)?'done':i===6?'planned':''}"><i>${[1,3].includes(i)?'✓':''}</i>${d}</span>`).join('')}</div></div></section>
      <section class="assistant-invite"><span class="assistant-icon">${icon('bot')}</span><span class="spark-decoration" aria-hidden="true">✦</span><h3>一个想法，也可以聊聊</h3><p>让 AI 帮你梳理方向、查找素材。<br>每一次写入，仍然由你决定。</p><button class="text-button" data-nav="agent">打开 AI 对话 ${icon('arrow')}</button></section>
      <div class="creative-usage"><span>今日 AI 用量 <strong>8.6k</strong></span><button class="text-button" data-action="creative-usage">查看用量 ${icon('arrow')}</button></div>
    </aside></div>
    <div class="creative-footer"><span>共 12 篇进行中的作品 · 本周已发布 2 篇</span><div class="actions"><button class="text-button" data-action="creative-health">${icon('user')} 账号健康度 82%</button><button class="text-button" data-nav="calendar">${icon('calendar')} 内容日历</button><button class="text-button" data-nav="profile">${icon('book')} 风格与记忆</button></div></div>
  </div>`;
}
function worksView() {
  const statuses=['全部','创作中','检查中','待审阅','可发布',state.account === 'wx' ? '已进草稿箱' : '发布包','已发布'];
  return `<div class="page">${pageTop('作品','每一篇内容，都有自己的生长节奏。',button(icon('download')+' 导入旧文','import')+button(icon('plus')+' 新建作品','new-work','primary'))}<div class="tabs" role="tablist" aria-label="作品状态">${statuses.map((label,index) => `<button role="tab" aria-selected="${label === state.workFilter}" class="${label === state.workFilter ? 'active' : ''}" data-filter="${label}">${label}<span class="tab-count">${[12,5,1,1,2,1,2][index]}</span></button>`).join('')}</div><div class="filters"><div class="input-wrap">${icon('search')}<input id="work-search" placeholder="搜索作品名称或标签" value="${esc(state.query)}" aria-label="搜索作品"></div><select id="tag-filter" aria-label="作品标签"><option value="">全部标签</option><option>时间管理</option><option>生活观察</option><option>效率习惯</option></select><select aria-label="负责人" id="owner-filter"><option>全部负责人</option><option>林知</option></select><span class="toolbar-spacer"></span><span class="muted" style="font-size:11px">示例展示 5 篇作品</span></div><div class="list-panel" id="works-list">${workRows()}</div><p class="hint" style="margin-top:14px">计划发布日只用于提醒；公众号草稿、小红书发布包仍需由你在对应平台完成发布。</p></div>`;
}
function workBar() {
  const last = state.account === 'wx' ? '公众号草稿' : '小红书发布包';
  return `<div class="workbar"><div class="workbar-top"><div class="workbar-title"><span class="platform ${state.account === 'wx' ? 'wx' : 'xhs'}">${state.account === 'wx' ? '公' : '红'}</span><strong>${workTitle}</strong>${badge('创作中','blue')}</div><div class="actions"><button class="icon-button" data-action="work-history" aria-label="版本历史" title="版本历史">${icon('clock')}</button><button class="icon-button" data-action="focus" aria-label="切换专注模式" title="专注模式">${icon('expand')}</button><button class="icon-button" data-action="work-more" aria-label="作品更多操作">${icon('more')}</button>${button('去检查 '+icon('arrow'),'go-check','primary small')}</div></div><div class="workbar-flow-label">发布进度：内容写完后按状态推进</div><div class="tabs" aria-label="作品流程">${['编辑','对照','排版预览','发布前检查',last].map(label => `<button class="${state.workTab === label ? 'active' : ''}" data-work-tab="${label}">${label}</button>`).join('')}<button data-action="shape" style="margin-left:auto">${state.shape === 'article' ? '长文编辑器' : state.shape === 'cards' ? '图文卡片' : '漫画分镜'} ⌄</button></div></div>`;
}
function articleEditor() {
  return `<div class="editor-grid"><aside class="outline"><div class="outline-label">创作流程</div><button class="outline-item" data-action="viewpoint">${icon('check')} 核心观点</button><button class="outline-item" data-action="outline">${icon('check')} 已确认大纲</button><div class="outline-divider"></div><div class="outline-label">文稿目录</div>${['从忙碌中停一下','给重要的事留白','把选择权拿回来','从今天的小事开始'].map((title,index) => `<button class="outline-item ${state.section === index ? 'selected' : ''}" data-section="${index}"><span class="num">0${index+1}</span>${title}</button>`).join('')}<div class="outline-divider"></div><button class="outline-item" data-action="work-properties">作品属性与关系</button><button class="outline-item" data-action="images-tools">标题、摘要与配图</button></aside><div class="editor-scroll"><article class="paper"><div class="document-meta"><span>知行笔记</span><span>／</span><span>时间管理</span><span style="margin-left:auto">${badge('AI 草稿 · 可编辑','blue')}</span></div><h1>${workTitle}</h1><div class="intro">核心观点：时间管理的起点，是先确认什么对自己真正重要。</div><section class="document-section active-section" id="section-0"><h2>01　从忙碌中停一下</h2><div class="editor-format" role="toolbar" aria-label="段落格式"><button data-format="bold" aria-label="加粗"><b>B</b></button><button data-format="italic" aria-label="斜体"><i>I</i></button><span class="format-divider"></span><button data-format="insertUnorderedList" aria-label="项目列表">≡</button><button data-action="insert-link" aria-label="插入链接">${icon('link')}</button><span class="format-divider"></span><button data-action="section-undo" aria-label="撤销段落编辑">↶</button><button data-action="section-redo" aria-label="重做段落编辑">↷</button></div><div class="editable" contenteditable="true" role="textbox" aria-label="第一段正文" aria-multiline="true" id="editable-body">${state.editorText === null ? baseParagraphs.map(p => `<p>${p}</p>`).join('') : state.editorText}</div><div class="section-tools"><span>本段 268 字</span><span>·</span><button data-action="rewrite-section">改写本段</button><button data-action="continue-section">续写</button><button data-action="variants">查看候选</button></div><div class="reference-line">${icon('book')} 本段参考：账号定位 · 风格样本 3 篇 · 亲身经历「一小时写作实验」</div></section><section class="document-section" id="section-1"><h2>02　给重要的事留白</h2><p style="font-size:15px;line-height:1.95">留白并不是浪费。它是一种选择：为真正值得投入的事，预留一段不被打断的时间。</p><div class="section-tools"><span>AI 草稿</span><span>·</span><button data-action="rewrite-section">改写本段</button><button data-action="continue-section">续写</button></div></section><section class="document-section" id="section-2"><h2>03　把选择权拿回来</h2><div class="notice">这个段落还没有起草。参考确认的大纲，先写下自己的观察。</div>${button(icon('spark')+' 起草这一段','draft-section','small')}</section><section class="document-section" id="section-3"><h2>04　从今天的小事开始</h2><p class="muted">结尾：从为自己留下二十分钟开始。</p></section></article></div><aside class="context-tools"><div class="tool-title">作品工具<button class="icon-button" data-action="tools" aria-label="更多作品工具">${icon('more')}</button></div><div class="tool-tabs">${['素材','助手','待核实','评论'].map(label => `<button class="${state.tool === label ? 'active' : ''}" data-tool="${label}">${label}</button>`).join('')}</div><div id="tool-content">${toolContent()}</div></aside></div>`;
}
function toolContent() {
  if (state.tool === '素材') return `<p class="tool-note">本账号与共享素材。关联来源后，AI 能更准确地使用你的真实经历。</p>${[{kind:'亲身经历',title:'一小时写作实验',body:'上周开始，每天上午不看消息，留一小时只写作。注意力明显更集中。'},{kind:'观点',title:'忙碌不等于有意义',body:'日程排得越满，有时越容易回避真正重要的选择。'}].map(item => `<article class="source-card">${badge(item.kind)}<div style="margin-top:9px"><strong>${item.title}</strong></div><p>${item.body}</p><small>来源：林知 · 10 月 14 日</small><div><button class="text-button" data-action="reference">${icon('link')} 关联到当前段落</button></div></article>`).join('')}<button class="button small" data-action="materials-picker" style="width:100%">${icon('plus')} 选择其他素材</button><button class="text-button" style="margin-top:16px" data-action="inbox-picker">从收件箱整理 ${icon('arrow')}</button>`;
  if (state.tool === '待核实') return `<p class="tool-note">发现 1 处需要补充来源。此处仅是写作提醒，发布前仍需逐项检查。</p><article class="source-card"><strong>「注意力明显更集中」</strong><p>如果写成普遍结论，需要来源；个人感受可明确写为亲身经历。</p>${button('定位到正文','locate','small')}${button('查看来源','materials-picker','ghost small')}</article>`;
  if (state.tool === '评论') return `<p class="tool-note">作品协作 · 评论与活动</p><article class="source-card"><strong>林知</strong><p>这段保留具体的写作场景，读起来更自然。</p><small>今天 10:18</small></article><label class="field">添加评论<textarea rows="4" id="comment-input" placeholder="针对当前段落留下意见"></textarea></label>${button('发送评论','comment','small')}<button class="text-button" style="margin:15px 0" data-action="activity">查看活动记录</button>`;
  return `<p class="tool-note">保留原创作助手、润色、通读和活动工具。</p>${['优化这一段的表达','为这一段补充例子','通读整篇，提出修改建议','查看润色与修改记录'].map(text => `<button class="source-card" style="width:100%;text-align:left" data-action="assistant-tool">${icon('spark')} ${text}</button>`).join('')}<p class="hint">生成建议先由你查看，不直接覆盖正文。</p>`;
}
function shapeEditor() {
  if (state.shape === 'cards') return `<div class="work-content"><div class="notice">图文卡片形态示意 · 各页独立编辑，保留逐张出图、预览与导出。</div><div class="card-canvas">${['把时间，留给重要的事','为自己留一段空白','先做选择，再安排时间'].map((title,i) => `<article class="content-card"><small>知行笔记 / 0${i+1}</small><h2>${title}</h2><p contenteditable="true" role="textbox" aria-label="第 ${i+1} 张卡片文案">${baseParagraphs[i]}</p><div style="margin-top:35px">${button('编辑这张卡片','card-properties','small')}${button('生成本页图片','generate-image','ghost small')}</div></article>`).join('')}</div></div>`;
  return `<div class="work-content"><div class="notice">漫画形态示意 · 角色、分镜确认、逐格文案、回传配图继续独立保留。${button('选择角色 / 确认分镜','storyboard','ghost small')}</div><div class="comic-canvas">${['清晨，关掉消息提醒','坐到窗边，打开笔记本','写下今天最重要的事','为自己留出一点时间'].map((title,i) => `<section class="comic-panel"><div class="meta">${badge('第 '+(i+1)+' 格','blue')}<strong>${title}</strong></div><div class="image-art">${icon('image')}<span>分镜配图位置</span></div><label class="field">旁白 / 对白<textarea rows="2">${title}。</textarea></label><div class="actions">${button('上传本格图片','upload-image','small')}${button('生成本格图片','generate-image','small')}</div></section>`).join('')}</div></div>`;
}
function workFlowView() {
  if (state.workTab === '对照') return `<div class="work-content"><div class="notice blue">源作品与衍生作品对照。更改不会自动覆盖另一篇；保留同步提示与逐段修改。</div><div class="compare-grid">${['公众号 · 源作品','小红书 · 衍生笔记'].map((label,i) => `<article class="paper preview-document"><div class="document-meta">${label}</div><h1>${i ? '把时间还给自己' : workTitle}</h1>${baseParagraphs.map(p=>`<p>${p}</p>`).join('')}${button(i ? '继续编辑衍生作品' : '查看作品关系','derive','small')}</article>`).join('')}</div></div>`;
  if (state.workTab === '排版预览') return `<div class="work-content"><div class="work-two-col"><article class="paper preview-document"><div class="document-meta">知行笔记 · 公众号排版预览</div><h1>${workTitle}</h1><p class="muted">林知　2026 年 10 月 16 日</p><h2>从忙碌中停一下</h2>${baseParagraphs.map(p => `<p>${p}</p>`).join('')}<h2>给重要的事留白</h2><p>留白并不是浪费，而是把注意力留给值得投入的事。</p></article><aside><div class="settings-card"><h3>文章外观</h3><label class="field">排版主题<select id="article-theme"><option>简洁阅读</option><option>清新笔记</option><option>经典文章</option><option>我的自定义主题</option></select></label><label class="field">正文大小<select id="article-size"><option>16 px</option><option>18 px</option><option>15 px</option></select></label><div class="actions">${button('复制公众号 HTML','copy-html','small')}${button('复制富文本','copy-rich','small')}</div></div><div class="notice">应用的浅色/深色主题只影响灵感空间界面，不改变平台排版结果。</div>${button('去发布前检查 '+icon('arrow'),'go-check','primary')}</aside></div></div>`;
  if (state.workTab === '发布前检查') {
    const checks=[['事实核实','「注意力明显更集中」是个人经历，请确认表述和来源。',['已核实','已修改']],['敏感词与广告法','未发现阻塞项。请仍确认文稿中的用词与实际内容相符。',['已知悉，保留','已修改']],['AI 使用声明','请确认在平台发布时，按实际使用情况填写 AI 辅助声明。',['已知悉，发布时会声明']]];
    return `<div class="work-content"><div class="work-two-col"><article class="paper preview-document"><div class="document-meta">正文定位 · 发布前检查</div><h1>${workTitle}</h1>${baseParagraphs.map((p,i) => `<p ${i===1?'style="background:var(--confirm-soft);border-radius:4px;padding:8px"':''}>${p}</p>`).join('')}<div class="notice">内容更改后，检查结果和已开启的审阅会失效。</div></article><aside><div class="section-heading"><h2>检查项</h2><span class="tag">${state.checkDone.size} / 3 已确认</span></div>${checks.map(([title,desc,choices],i) => `<section class="check-item ${state.checkDone.has(i)?'done':''}"><div class="meta"><strong style="color:var(--text)">${title}</strong>${state.checkDone.has(i)?badge('已确认','green'):badge('需人工确认','amber')}</div><p>${desc}</p>${state.checkDone.has(i)?`<div class="hint">处理方式：${esc(state.checkChoices[i])}</div>`:`<select data-check-choice="${i}" aria-label="${title}处理方式"><option value="">请选择处理方式</option>${choices.map(c=>`<option ${state.checkChoices[i]===c?'selected':''}>${c}</option>`).join('')}</select><button class="button human small" data-check="${i}" ${state.checkChoices[i]?'':'disabled'}>确认这一项</button>`}</section>`).join('')}<div class="notice">示例只展示 3 个检查项的交互。正式界面须保留原全部检查分类、报告与审阅门槛。</div>${button('查看检查报告','check-report','small')}<div style="margin-top:12px">${button(state.account==='wx'?'去写入公众号草稿箱':'去生成小红书发布包','go-publish','primary',state.checkDone.size<3?'disabled':'')}</div></aside></div></div>`;
  }
  const xhs = state.workTab === '小红书发布包';
  return `<div class="work-content"><div style="max-width:850px;margin:auto">${pageTop(xhs?'准备小红书发布包':'写入公众号草稿箱',xhs?'生成可下载的文字与图片，再由你前往平台发布。':'内容进入草稿箱，之后仍由你在微信公众平台完成发表。')}<div class="notice ${state.checkDone.size<3?'amber':'green'}">${state.checkDone.size<3?'本次预览中的检查尚未逐项确认。请先去发布前检查。':'本次预览检查已完成；真实版本仍需校验服务端状态与审阅门槛。'}</div><div class="settings-card"><h3>${workTitle}</h3><div class="meta">${badge(xhs?'小红书':'公众号')}<span>作者：林知</span><span>1,248 字</span></div><div class="setting-row"><div><strong>${xhs?'文字、话题与图片':'发布衔接方式'}</strong><small>${xhs?'保留分别复制、图片下载、ZIP、分享和二维码。':'写入草稿箱；遇到后台修改或原草稿消失时，由你选择另建或覆盖。'}</small></div></div>${xhs?`<div class="actions" style="margin-top:20px">${button('复制标题','copy-title','small')}${button('复制正文','copy-body','small')}${button('图片与 ZIP','pack-download','small')}${button('分享 / 二维码','pack-share','small')}</div>`:''}<div class="actions" style="margin-top:22px">${button(xhs?'确认生成发布包':'确认写入草稿箱','publish-demo','primary',state.checkDone.size<3?'disabled':'')}${button('返回检查','go-check','')}</div></div><div class="settings-card"><h3>发布后的衔接</h3><p class="settings-description">在平台完成发布后，再回填链接与时间。计划发布日不会自动触发发布。</p>${button('回填已发布信息','backfill','small')}${!xhs?button('查看微信后台入口','external-link','ghost small'):''}</div></div></div>`;
}
function editorView() { return `<div class="editor ${state.focus?'focus-mode':''}">${workBar()}${state.workTab==='编辑'?(state.shape==='article'?articleEditor():shapeEditor()):workFlowView()}<div class="editor-bottom"><span>${state.shape==='article'?'1,248 字 · 4 个段落':'按作品形态编辑'}　${state.focus?'专注模式':''}</span><button class="text-button" data-action="tools">${icon('panel')} 作品工具</button><span>保存演示 · 真实版本沿用自动保存与冲突处理</span></div></div>`; }

function actionCard(id,title,body) {
  const done = state.cards.has(id);
  return `<article class="action-card ${done?'done':''}" data-card="${id}"><div class="card-head">${icon(done?'check':'file')}<strong>${title}</strong><span style="margin-left:auto">${badge(done?'已执行（演示）':'等待你的确认',done?'green':'amber')}</span></div><div class="card-body"><p>${body}</p><p>操作账号：知行笔记 · 仅影响这一条选题</p><small class="muted">依据：账号定位、已确认的写作记忆、你提供的方向</small></div><div class="card-footer"><span>${done?'仅更新了原型内的状态':'确认后才会执行，不自动写入'}</span><div class="actions">${done?button('查看选题','card-result','small'):`<button class="button ghost small" data-card-reject="${id}">拒绝</button><button class="button human small" data-card-preview="${id}">预览并确认</button>`}</div></div></article>`;
}
function creativeChatView() {
  return `<div class="agent-shell"><div class="chat-header"><div class="meta"><strong style="color:var(--text)">本周选题与写作安排</strong>${badge('仅本人可见')}</div><button class="text-button" data-action="agent-options">对话设置 ${icon('settings')}</button></div><div class="chat-stream" id="chat-stream"><div class="chat-inner"><div class="chat-day">今天 · 10:32</div><div class="message user"><div class="speaker"><span class="user-avatar" style="width:23px;height:23px;font-size:10px">林</span>你 <small>10:32</small></div><div class="message-body">想围绕「把时间留给重要的事」做两篇后续内容，先帮我看看适合哪些选题，不要直接开始写。</div></div><div class="message"><div class="speaker"><span class="bot">${icon('bot')}</span>OPS <small>已完成参考资料读取</small></div><div class="message-body"><div class="tool-event">${icon('check')} 读取账号档案与近期作品 · 2 项只读操作</div><p>你的账号更适合从具体经历出发。建议把「时间」拆成两个更小的切口，一篇谈选择，一篇谈实践。</p><p style="margin-top:10px">下面是两条待入库的选题。你可以分别查看和确认，也可以继续调整方向。</p>${actionCard('topic-1','添加选题：不再用忙碌证明自己','从「把日程排满」的习惯出发，讨论如何辨认值得投入的事。')}${actionCard('topic-2','添加选题：每天留二十分钟给自己','记录一周的留白实践，以真实经历说明小幅调整如何发生。')}<p class="hint">这里只提出选题；观点、大纲与正文仍需要你逐步确认。</p></div></div><div id="new-messages">${state.agentMessages.map(m=>messageHTML(m)).join('')}</div></div></div><div class="chat-compose"><div class="compose-inner"><div class="compose-box"><div id="attachments"></div><textarea id="chat-input" aria-label="发送给 AI 的消息" placeholder="说说你想写什么，或继续调整上面的方向…"></textarea><div class="compose-toolbar"><button class="icon-button" data-action="attach" aria-label="添加附件">${icon('paperclip')}</button><button class="text-button" data-action="agent-options"><span class="platform wx" style="width:18px;height:18px;font-size:9px">公</span> 知行笔记 ⌄</button><span class="spacer"></span><button class="text-button" data-action="agent-options">标准模型 ⌄</button><button class="button ${state.busy?'':'primary'} small" id="send-button" data-action="${state.busy?'stop-chat':'send-chat'}">${state.busy?'停止':'发送 ↑'}</button></div></div><div class="compose-note">${state.busy?'正在生成示例回复，可随时停止。':'Enter 发送 · Shift+Enter 换行 · AI 输出请自行核实，写入操作需逐张确认'}</div></div></div></div>`;
}

function agentView() {
  return `<div class="creative-agent-layout"><aside class="agent-conversations"><h2>AI 对话</h2>${button(icon('plus')+' 新对话','creative-new-chat','primary')}<input class="conversation-search" aria-label="搜索对话" placeholder="搜索最近的对话"><div class="nav-label">今天</div><div class="conversation-list"><button class="nav-item active" data-action="conversation">本周选题与写作安排<small>2 张待确认卡片</small></button><button class="nav-item" data-action="conversation">整理最近的写作素材<small>昨天</small></button><button class="nav-item" data-action="conversation">关于账号定位的讨论<small>10 月 14 日</small></button></div><div style="margin-top:30px" class="notice"><span style="font-size:10px">你的对话仅本人可见。操作卡片执行后，仍保留原操作日志。</span></div></aside>${creativeChatView()}</div>`;
}

function messageHTML(message) {
  return `<div class="message ${message.role==='user'?'user':''}"><div class="speaker">${message.role==='user'?'<span class="user-avatar" style="width:23px;height:23px">林</span> 你':`<span class="bot">${icon('bot')}</span> OPS`}<small>原型演示</small></div><div class="message-body" ${message.streaming?'id="stream-response"':''}>${esc(message.text)}</div></div>`;
}
const topicSamples = ['不再用忙碌证明自己','每天留二十分钟给自己','一个不安排工作的周末','把选择权拿回来'];
function topicsView() {
  return `<div class="page">${pageTop('选题池','先存下想法，再决定哪一条值得开始。',button(icon('spark')+' AI 选题建议','topic-suggest')+button(icon('plus')+' 添加选题','new-topic','primary'))}<div class="tabs">${['待定','已采用','已放弃','收件箱','系列'].map(t=>`<button class="${state.topicTab===t?'active':''}" data-topic-tab="${t}">${t}${t==='待定'?'<span class="tab-count">8</span>':''}</button>`).join('')}</div><div class="filters"><div class="input-wrap">${icon('search')}<input id="topic-search" aria-label="搜索选题" placeholder="搜索当前页选题"></div><select aria-label="选题来源"><option>全部来源</option><option>手动</option><option>AI 建议</option><option>热点</option><option>复盘</option><option>每日推荐</option></select></div><div class="split-page"><div class="panel" id="topic-list">${(state.topicTab==='收件箱'?[...state.collect,'周末散步时想到：不安排的时间，也可能最有价值。']:state.topicTab==='系列'?['慢一点，也没关系','注意力练习']:topicSamples).map((title,i)=>`<article class="topic-row">${badge(state.topicTab==='收件箱'?'灵感收集':i%2?'手动':'AI 建议',i%2?'':'blue')}<h3>${esc(title)}</h3><p>${state.topicTab==='系列'?'系列进度、关联作品与上一篇/下一篇继续保留。':'从真实生活中的小场景出发，讲清一个观点。参考来源与采用理由可在详情中查看。'}</p><div class="actions">${state.topicTab==='收件箱'?button('整理为素材','inbox-picker','small')+button('转为选题','new-topic','small'):state.topicTab==='系列'?button('查看系列作品','series','small'):button('采用并开始写','adopt-write','primary small')+button('采用','adopt','small')+button('放弃','drop-topic','ghost small')}</div></article>`).join('')}</div><aside class="panel details-panel"><div class="eyebrow">选题详情</div><h2>${topicSamples[0]}</h2><p>角度：从「排满日程」到「主动选择」，结合一段亲身经历，避免泛泛而谈。</p><div class="meta">${badge('时间管理')}${badge('待定','amber')}</div><div class="outline-divider"></div><h3>参考与来源</h3><p>账号定位：生活观察与自我管理<br>近期内容：把时间留给真正重要的事<br>选题来源：AI 建议，尚未入库</p><p class="hint">采用不会自动确认观点、大纲或起草正文。</p></aside></div></div>`;
}
function calendarView() {
  const today = 16;
  return `<div class="page">${pageTop('内容日历','计划是提醒，发布仍由你在平台完成。',button('当前账号 ⌄','calendar-scope'))}<div class="calendar-toolbar"><div class="actions">${button('‹','calendar-prev','small')}<h2>2026 年 10 月</h2>${button('›','calendar-next','small')}${button('回到本月','calendar-today','ghost small')}</div><div class="actions">${button('月','calendar-month','primary small')}${button('周','calendar-week','small')}</div></div><div class="calendar">${['一','二','三','四','五','六','日'].map(d=>`<div class="weekday">周${d}</div>`).join('')}${Array.from({length:35},(_,i)=>{const d=i-2;const valid=d>0&&d<32;return `<div class="day-cell ${d===today?'today':''}" ${valid?`data-date="2026-10-${String(d).padStart(2,'0')}"`:''}><span class="day" style="${valid?'':'opacity:.35'}">${valid?d:d<=0?30+d:d-31}</span>${[6,11,16,18,23,28].includes(d)?`<button class="calendar-event" data-nav="editor">${d===18?workTitle:['注意力练习','周末重启清单','留一点时间'][d%3]}</button>`:''}</div>`;}).join('')}</div><section class="panel calendar-topics"><div class="section-heading"><h2>未排期的作品与选题</h2>${button('选择日期排期','schedule','small')}</div><div class="meta">${icon('file')} 把选择权拿回来 ${badge('创作中','blue')}<span>可拖动到日期；也可用日期输入完成同一操作。</span></div></section></div>`;
}
function materialsView() {
  return `<div class="page">${pageTop('素材库','保留事实与真实经历，让表达有自己的来处。',button(icon('inbox')+' 收件箱整理','inbox-picker')+button(icon('plus')+' 添加素材','new-material','primary'))}<div class="tabs">${['全部','经历','观点','案例','数据'].map((label,i)=>`<button ${i?'':'class="active"'} data-material-type="${label}">${label}</button>`).join('')}</div><div class="filters">${button('多选','select-materials','small')}<div class="input-wrap">${icon('search')}<input placeholder="搜索素材内容与来源" id="material-search" aria-label="搜索素材"></div><select aria-label="素材范围"><option>本账号 + 工作区共享</option><option>本账号</option><option>工作区共享</option></select></div><div class="split-page"><div class="panel" id="material-list">${['一小时写作实验','忙碌不等于有意义','读者来信：重新找回周末','注意力与任务切换研究'].map((title,i)=>`<article class="topic-row" data-kind="${['经历','观点','案例','数据'][i]}"><div class="meta">${badge(['经历','观点','案例','数据'][i],i===0?'green':'')}<small>${i===3?'工作区共享':'知行笔记'}</small></div><h3>${title}</h3><p>${baseParagraphs[i%3]}</p><div class="meta"><span>来源：${i===3?'示例研究记录，正式使用前须核实':'林知的生活笔记'}</span><button class="text-button" data-action="material-detail">查看与编辑 ${icon('arrow')}</button></div></article>`).join('')}<div style="padding:16px">${button('加载更多素材','load-materials','small')}</div></div><aside class="panel details-panel"><div class="eyebrow">素材详情</div><h2>一小时写作实验</h2><p>${baseParagraphs[1]}</p><div class="meta">${badge('经历','green')}${badge('本账号')}</div><div class="outline-divider"></div><h3>引用与关联</h3><p>已用于 1 篇作品。素材来源、有效期、共享范围和关联段落均继续保留。</p>${button('编辑这条素材','material-detail','small')}</aside></div></div>`;
}
function imagesView() {
  return `<div class="page">${pageTop('图片库','当前工作区的图片，打开详情即可查看来源、替代文字与复用位置。')}<div class="filters"><div class="input-wrap">${icon('search')}<input placeholder="搜索图片描述" aria-label="搜索图片" id="image-search"></div><select aria-label="图片来源"><option>全部作品</option><option>当前账号</option><option>共享图片</option></select></div><div class="image-grid">${['窗边的写作时间','安静的一页纸','留白与日常','工作台的一角','给周末的小清单','一点自己的时间','清晨的笔记','选择与节奏'].map((title,i)=>`<button class="image-card" data-image="${i}"><div class="image-art"><div class="art-window"><i></i><i></i><i></i><i style="width:65%"></i></div></div><div class="caption">${title}<small>示例插画 · 1200 × 900 · PNG</small></div></button>`).join('')}</div><p class="hint" style="margin-top:20px">此处使用内置示意插画。正式界面保留缩略图、原图详情与资产权限。</p></div>`;
}
function opsView() {
  const sections={
    '运营方案':['当前方案 · 第 3 版','定位：从具体生活观察出发，谈自我管理和注意力。','内容支柱：时间与选择 40% / 生活练习 35% / 阅读与表达 25%。','每周三篇，优先讲清一件具体的小事。'],
    '内容大纲':['本周内容槽位','10 月 16 日 · 一份适合普通人的周末重启清单','10 月 18 日 · 把时间留给真正重要的事','10 月 21 日 · 把选择权拿回来'],
    '热点参考':['与账号定位相关的热点','围绕具体生活场景展开，避免为了热点偏离账号定位。','保留来源、时效、相关性、逐条转为选题与刷新。'],
    '对标参考':['值得学习的表达方式','保留对标账号、我欣赏它什么、代表作与来源记录。','关注表达方法，避免直接照搬内容。'],
    '每日推荐':['今天的创作参考','主推：不再用忙碌证明自己','备选：每天留二十分钟给自己','每条分别查看理由、采纳、忽略和重试。'],
    '推荐统计':['最近 7 天 · 推荐与采纳','已生成 18 条 · 已采用 7 条 · 生成失败 1 次','可查看按账号、来源与时间的结果及异常提示。']
  };
  return `<div class="page">${pageTop('账号运营','让定位、内容节奏与每天的创作连接起来。',button('起号问卷','ops-questionnaire')+button('版本历史','ops-history'))}<div class="tabs">${Object.keys(sections).map(label=>`<button data-ops-tab="${label}" class="${state.opsTab===label?'active':''}">${label}</button>`).join('')}</div><div style="margin-top:22px" class="split-page"><section class="settings-card"><div class="section-heading"><h2>${sections[state.opsTab][0]}</h2>${badge('知行笔记','blue')}</div>${sections[state.opsTab].slice(1).map(text=>`<div class="setting-row"><div><strong>${text}</strong><small>示例内容 · 保留原页面的查看、编辑和逐项操作。</small></div>${button('查看','ops-detail','small')}</div>`).join('')}<div class="actions" style="margin-top:23px">${button(state.opsTab==='运营方案'?'调整当前方案':'准备参考建议','ops-generate','primary')}${button(state.opsTab==='运营方案'?'查看启用与历史':'查看来源和生成记录','ops-detail')}</div></section><aside class="panel details-panel"><h2>内容节奏</h2><p>本周计划 3 篇<br>长图文 · 周三 / 周五 / 周日<br>下一篇：10 月 18 日</p><div class="notice amber">生成建议与采用分开；采用后也不会自动确认观点、大纲或批量起稿。</div>${button('查看内容日历','open-calendar','small')}</aside></div></div>`;
}
function reviewView() {
  return `<div class="page">${pageTop('数据复盘','先记录真实结果，再把观察变成下一次创作的参考。',button('截图识别','review-screenshot')+button('录入数据','review-data','primary'))}<div class="compact-stats"><div class="stat"><small>近 7 天阅读</small><div class="number">6,842 <span>示例</span></div></div><div class="stat"><small>收藏</small><div class="number">286</div></div><div class="stat"><small>分享</small><div class="number">149</div></div><div class="stat"><small>粉丝净增</small><div class="number">68</div></div></div><div class="section-heading"><h2>作品数据 · 发布后第 7 天</h2><div class="actions">${button('粉丝记录','review-followers','small')}${button('同步与匹配','review-match','small')}</div></div><div class="panel table-wrap"><table class="work-table"><thead><tr><th>作品</th><th>阅读</th><th>收藏</th><th>分享</th><th>记录方式</th></tr></thead><tbody>${works.slice(2).map((w,i)=>`<tr><td>${w.title}</td><td>${[2864,2145,1833][i]}</td><td>${[128,91,67][i]}</td><td>${[62,51,36][i]}</td><td>${badge(i?'人工录入':'截图识别')}</td></tr>`).join('')}</tbody></table></div><div class="insight-row"><section class="settings-card"><h3>本周复盘草稿</h3><p class="settings-description">带有亲身经历的开头更容易引发读者的回应。下周可以继续尝试具体场景，并记录反馈。</p>${button('查看报告与证据','review-report')}${button('采纳这一条建议','review-adopt','human small')}</section><section class="settings-card"><h3>趋势与数据来源</h3><p class="settings-description">保留原数据看板、趋势分析、待匹配文章、粉丝记录与逐条建议采纳。数字不会仅因界面动画而变化。</p>${button('查看趋势','review-trend','small')}</section></div></div>`;
}
function profileView() {
  const names=['定位','风格样本','AI 记忆',state.account==='wx'?'排版':'角色卡'];
  return `<div class="page">${pageTop('账号档案','定位、语气与表达习惯，始终属于当前平台账号。')}<div class="tabs">${names.map(t=>`<button data-profile-tab="${t}" class="${state.profileTab===t?'active':''}">${t}</button>`).join('')}</div><div style="margin-top:23px;max-width:850px" class="settings-card"><h2>${state.profileTab}</h2><p class="settings-description">${state.profileTab==='AI 记忆'?'每条写作记忆需要你确认后才生效，停用和来源均可查看。':state.profileTab==='风格样本'?'保留单篇样本上传、录入、解析和管理。':state.profileTab==='排版'?'只影响之后新建作品的默认文章外观，不改变空间主题。':'保留当前账号的定位、目标读者、人设语气、禁用词和原有字段。'}</p>${state.profileTab==='定位'?`<div class="field-grid"><label class="field">账号领域<input value="生活观察与自我管理"></label><label class="field">目标读者<input value="希望重新掌握生活节奏的普通人"></label></div><label class="field">人设与语气<textarea rows="4">用亲身经历说话，温和、具体、坦诚。避免命令式表达与空泛的励志。</textarea></label><label class="field">禁用词<input value="一键爆文、全自动"></label>`:['写具体的经历，少写抽象的道理','保留自然的停顿与简短句子','以一个小行动结束文章'].map(text=>`<div class="setting-row"><div><strong>${text}</strong><small>示例条目 · 仍需遵守原权限与确认。</small></div>${button('查看与编辑','profile-detail','small')}</div>`).join('')}<div class="actions" style="margin-top:20px">${button(state.profileTab==='定位'?'保存档案':'添加一条','save-profile','primary')}${button('查看来源与默认值','profile-detail')}</div></div></div>`;
}

const settingGroups = [
  ['常用设置',['偏好设置','平台账号与凭证','成员与邀请','服务器模型']],
  ['AI 与内容',['智能体设置','AI 用量与成本','AI 质量看板','敏感词库','提示词模板','热点来源','每日推荐设置']],
  ['数据与安全',['数据导出','操作日志','回收站','登录与安全']],
  ['管理员',['系统管理','热点采集与日志']],
];
const settingSpecs = {
  '平台账号与凭证':{desc:'平台账号与类型、凭证和归档。账号类型创建后固定。',rows:['知行笔记 · 公众号 · 长图文','知行日常 · 小红书 · 图文卡片'],actions:['添加平台账号','管理凭证']},
  '成员与邀请':{desc:'工作区角色、成员与邀请码。owner / editor / viewer 沿用原权限。',rows:['林知 · owner · 当前成员','陈禾 · editor','周一 · viewer'],actions:['创建邀请码','查看邀请记录']},
  '服务器模型':{desc:'管理线上服务器使用的模型。此处不会读取或保存客户端本机密钥。',rows:['标准模型 · 文本 / JSON / 工具调用','视觉模型 · 看图 / 图片生成','任务路由 · 主模型与备用模型'],actions:['添加服务器供应商','模型能力与路由']},
  '智能体设置':{desc:'工作区级能力开关，不改变对话私有范围和逐卡确认。',checks:['允许使用系统智能体','允许观察者使用只读能力','允许成员自行选择模型']},
  'AI 用量与成本':{desc:'按原任务类型展示用量、成本、预算及调用明细。',rows:['今天 · 8,642 tokens · 示例费用 ¥0.24','本月 · 218,420 tokens · 示例费用 ¥6.18','每日额度 · 可设置上限'],actions:['查看调用明细','设置预算']},
  'AI 质量看板':{desc:'保留反馈、模型质量统计与原评估能力。',rows:['本周采纳率 · 78%','失败与重试 · 2 次','质量反馈 · 12 条'],actions:['查看质量反馈','打开评估']},
  '敏感词库':{desc:'保留词条范围、分组、规则与原编辑权限。',rows:['默认规则库','工作区自定义词条','账号禁用词来自账号档案'],actions:['添加词条','查看规则']},
  '提示词模板':{desc:'按任务管理原提示词模板与覆盖。',rows:['选题建议 · 工作区默认','分段起草 · 工作区默认','发布前检查 · 工作区默认'],actions:['编辑模板','恢复默认']},
  '热点来源':{desc:'已启用来源、自定义 RSS 与原生联网搜索分别配置。',rows:['工作区已启用来源','自定义 RSS','供应商原生联网搜索'],actions:['添加 RSS','管理来源']},
  '每日推荐设置':{desc:'配置工作区默认生成模式，账号可沿用或覆盖。时间使用北京时间。',fields:[['生成方式',['关闭，仅手动','打开时准备','每天后台准备']],['后台生成时间','07:00'],['主推数量','3'],['备选数量','2']]},
  '数据导出':{desc:'保留原导出格式、作用域与下载流程。',checks:['作品与版本','素材与来源','账号档案'],actions:['导出数据']},
  '操作日志':{desc:'日志仍按工作区隔离，来自智能体的动作保留标记。',rows:['今天 10:24 · 林知 · 编辑作品','今天 10:16 · 林知 · 采用选题 · 来自智能体','昨天 18:42 · 陈禾 · 提交审阅']},
  '回收站':{desc:'恢复与永久删除遵守原权限和二次确认。',rows:['未命名草稿 · 删除于 10 月 13 日','素材：一个周末想法 · 删除于 10 月 10 日'],actions:['恢复所选条目']},
  '登录与安全':{desc:'沿用原登录、重新认证与会话处理；密码不保存到本机模型配置。',fields:[['当前密码','', 'password'],['新密码','', 'password']],actions:['修改密码','查看会话']},
  '系统管理':{desc:'仅系统管理员可访问；原维护模式和代访问限制不变。此预览展示管理员布局。',checks:['维护模式'],rows:['工作区管理','用户与权限管理','系统运行状态'],actions:['查看系统状态']},
  '热点采集与日志':{desc:'仅系统管理员可访问；保留全站开关、来源、限额与日志。',checks:['允许热点采集'],rows:['来源状态与最近运行','敏感平台限额','采集日志'],actions:['查看采集日志']}
};
function fieldHTML(label,value,type='text',id='') {
  return `<label class="field">${label}${Array.isArray(value)?`<select ${id?`id="${id}"`:''}>${value.map(v=>`<option>${esc(v)}</option>`).join('')}</select>`:`<input type="${type}" value="${esc(value)}" ${id?`id="${id}"`:''}>`}</label>`;
}
function checkRow(label, checked = true, description = '') { return `<label class="setting-row"><span><strong>${label}</strong>${description?`<small>${description}</small>`:''}</span><span class="switch"><input type="checkbox" aria-label="${label}" ${checked?'checked':''}></span></label>`; }
function settingsBody() {
  const label = state.settingTab;
  if (label === '偏好设置') return `<h2>偏好设置</h2><p class="settings-description">个人偏好只影响你自己。写作设置和应用外观各自独立。</p><div class="settings-card"><h3>外观</h3><div class="setting-row"><div><strong>空间主题</strong><small>浅色与深色都保持相同的界面层级。</small></div><button class="button small" data-action="theme">${state.theme==='light'?'浅色 → 切换深色':'深色 → 切换浅色'}</button></div><div class="setting-row"><div><strong>减少动态效果</strong><small>尊重 Windows 系统的减少动态效果偏好。</small></div><label class="switch"><input type="checkbox" id="reduce-motion-input" aria-label="减少动态效果" ${state.reduced?'checked':''}></label></div></div><div class="settings-card"><h3>写作</h3>${checkRow('参考我的历史作品',true,'生成时保留本次参考来源。')}${checkRow('边写边提示敏感词',true,'提示不代替发布前逐项检查。')}${checkRow('续写建议（灰字）',true,'按原快捷键触发，Tab 采纳，Esc 放弃。')}${checkRow('起草后跳到下一个空段落',false)}${checkRow('默认进入专注模式',false)}${checkRow('先写结尾',false)}<div class="setting-row"><strong>每次生成候选数</strong><select aria-label="每次生成候选数"><option>1 个</option><option>3 个</option></select></div><div class="setting-row"><strong>续写快捷键</strong><select aria-label="续写快捷键"><option>Alt+Enter</option><option>Ctrl+Enter</option></select></div><div class="setting-row"><strong>默认 AI 档位</strong><select aria-label="默认 AI 档位"><option>标准</option><option>省钱</option><option>高质量</option></select></div></div><div class="settings-card">${checkRow('匿名记录使用体验事件',false,'只保留原可选事件统计，不记录正文。')}</div>${button('保存个人偏好','save-settings','primary')}`;
  const spec=settingSpecs[label];
  return `<h2>${label}</h2><p class="settings-description">${spec.desc}</p><div class="settings-card">${(spec.fields||[]).map(args=>fieldHTML(...args)).join('')}${(spec.checks||[]).map((t,i)=>checkRow(t,i===0)).join('')}${(spec.rows||[]).map(row=>`<div class="setting-row"><div><strong>${row}</strong><small>示例条目 · 正式版本复用原页面的数据和权限。</small></div>${button('查看','setting-detail','small')}</div>`).join('')}</div><div class="actions">${(spec.actions||['保存设置']).map((text,i)=>button(text,'setting-detail',i?'':'primary')).join('')}</div>${label==='服务器模型'?`<div class="notice blue" style="margin-top:20px">需要管理本机端点？请打开独立的客户端设置。${button('打开客户端设置','desktop-settings','ghost small')}</div>`:''}`;
}
function settingsView() {
  return `<div class="page">${pageTop('工作区设置','知行内容工作区 · 业务账号、协作、服务器 AI 与内容管理。',button('客户端设置 '+icon('arrow'),'desktop-settings'))}<div class="settings-layout"><nav class="settings-nav" aria-label="工作区设置分类">${settingGroups.map(([title,items])=>`<div class="nav-label">${title}</div>${items.map(label=>`<button class="nav-item ${label===state.settingTab?'active':''}" data-setting="${label}"><span>${label}</span>${title==='管理员'?'<span class="tag" style="font-size:9px;margin-left:auto">超管</span>':''}</button>`).join('')}`).join('')}</nav><section class="settings-content" id="workspace-settings-content">${settingsBody()}</section></div></div>`;
}
const localTabs=['连接与模式','本机模型','能力自检','任务映射','账号与设备','工作区策略','诊断与支持'];
function localSettingsBody() {
  const header = `<h2>${state.localTab}</h2><p class="settings-description">此设备 · Windows · 林知 / 知行内容工作区</p>`;
  if (state.localTab==='连接与模式') return header+`<div class="settings-card"><div class="setting-row"><div><strong>线上服务</strong><small>业务数据仍由线上服务提供</small></div>${badge('在线','green')}</div><div class="setting-row"><div><strong>客户端 AI 通道</strong><small>连接通道不调用模型，能力自检需要另外启动。</small></div>${badge(state.channel?'已连接':'未连接',state.channel?'green':'')}<button class="button small" data-action="channel">${state.channel?'断开':'连接 WSS 通道'}</button></div><div class="setting-row"><strong>当前已应用模式</strong>${badge(state.mode==='server'?'服务器 AI':'此客户端 AI','blue')}</div></div><div class="settings-card"><h3>选择业务 AI 执行模式</h3>${fieldHTML('准备应用的模式',['服务器 AI','此客户端 AI'],'text','mode-choice')}<div class="notice amber">应用前请先保存业务页面内容。确认后重新加载业务页；连接失败不会自动切换到其他模式。</div>${button('确认应用并重新加载','apply-mode','primary')}</div><div class="actions">${button('重新登录','reauth','small')}${button('重新加载业务页','reload-business','small')}</div>`;
  if (state.localTab==='本机模型') return header+`<div class="notice blue">管理此设备发起调用的端点。API Key 由本机系统密钥库保护，不传给业务页面。示例中请勿填写真实凭证。</div><form id="model-form"><div class="field-grid">${fieldHTML('配置名称',state.modelSaved?'写作模型（演示）':'写作模型','text','local-model-name')}${fieldHTML('已保存配置',['新建配置…',...(state.modelSaved?['写作模型（演示）']:[])],'text','local-saved-model')}</div>${fieldHTML('API 基础地址','http://127.0.0.1:1234/v1/','url','local-base-url')}<p class="hint" style="margin-top:-9px;margin-bottom:16px">公网 HTTPS 或本机回环地址。回环不等于业务内容只在本机流转。</p><label class="field">模型名称<textarea rows="2" id="local-model-names">example-text-model</textarea><span class="hint">每行或逗号分隔一个模型名称。</span></label>${fieldHTML('API Key（仅演示，请勿填真实密钥）','','password','local-api-key')}<p class="hint" style="margin-top:-8px;margin-bottom:16px">正式版本：留空保留已保存密钥；新建的无鉴权服务可留空。</p><div class="field-grid">${fieldHTML('模型服务代理',['直连','系统代理','手动 HTTP(S) 代理'],'text','local-proxy-mode')}${fieldHTML('手动代理地址','','url','local-proxy-url')}</div><div class="field-grid">${fieldHTML('代理用户名','','text','local-proxy-user')}${fieldHTML('代理密码（地址不变时留空保留）','','password','local-proxy-password')}</div>${fieldHTML('允许的图片 CDN 域名','images.example.com','text','local-image-hosts')}<p class="hint">完整域名匹配，不支持通配符。回环模型始终直连。此原型不会持久化输入值。</p><div id="model-form-error" class="notice red" hidden></div><div class="actions" style="margin-top:17px"><button class="button primary" type="submit">保存本机配置</button>${button('新建','new-local-model')}${button('刷新','refresh-local-model')}${state.modelSaved?button('删除配置','delete-local-model','danger'):''}</div></form>`;
  if (state.localTab==='能力自检') return header+`<div class="notice amber">自检会真实调用模型，可能产生费用。只使用合成输入，不读取作品、不执行业务工具。此 HTML 只模拟结果。</div>${fieldHTML('选择本机模型',['写作模型 / example-text-model'])}${button('启动能力自检（演示）','selftest','primary')}<div class="settings-card" style="margin-top:20px">${['文本','结构化 JSON','工具调用','看图','图片生成'].map((label,i)=>`<div class="setting-row"><strong>${label}</strong>${badge(state.tested?(i<3?'通过（演示）':'未测试'):'未测试',state.tested&&i<3?'green':'')}</div>`).join('')}</div>`;
  if (state.localTab==='任务映射') return header+`<div class="notice ${state.draftMap?'amber':'blue'}">${state.appliedMap?'已应用本次预览映射。':state.draftMap?'本机映射草稿已保存，等待确认应用。':'保存本机草稿不等于线上生效；应用模式时才提交映射。'} 默认任务必填，向量检索只使用服务器。</div><div class="route-grid"><span>任务</span><span>执行位置</span><span>主模型 / 备用</span></div>${['默认任务','分段起草','智能体对话','对话摘要','图片生成','向量检索'].map((task,i)=>`<div class="route-grid"><strong>${task}</strong><select aria-label="${task}执行位置" ${i===5?'disabled':''}><option>服务器</option>${i===5?'':'<option>此客户端</option><option>停用</option>'}</select><select aria-label="${task}模型"><option>${i===5?'服务器向量模型':'沿用工作区默认'}</option><option>本机写作模型</option></select></div>`).join('')}<div class="notice" style="margin-top:15px">备用模型同样必须明确执行位置与能力。辅助任务的服务器去向不能被隐藏。${button('配置主备用与任务详情','route-detail','ghost small')}</div>${button('保存本机映射草稿','save-map','primary')}`;
  if (state.localTab==='账号与设备') return header+`<div class="settings-card"><div class="setting-row"><strong>重新认证</strong>${button('输入账号密码','reauth','small')}</div><div class="setting-row"><strong>系统密钥库</strong>${badge('可用（示意）','green')}</div><div class="setting-row"><div><strong>本人已注册设备</strong><small>此设备 · 最近连接：今天 10:26</small></div>${button('撤销此设备','revoke-device','danger small')}</div><div class="setting-row"><strong>设备列表</strong>${button('刷新','refresh-devices','small')}</div></div><div class="settings-card"><h3>清除此账号本机数据</h3><p class="settings-description">删除当前账号在本机的密钥、私钥和映射草稿并退出登录。不删除线上作品，也不等于撤销线上设备。</p>${button('清除此账号本机数据','clear-local','danger')}</div>`;
  if (state.localTab==='工作区策略') return header+`<div class="notice amber">仅工作区 owner 可以修改。允许成员配置端点后，业务上下文可能发送到其配置的 AI 服务。</div><div class="settings-card">${checkRow('允许此工作区使用桌面 AI',true)}${checkRow('允许 editor 使用各自的桌面 AI 端点',false)}</div>${button('保存工作区策略','save-policy','primary')}`;
  return header+`<div class="settings-card"><h3>诊断与支持</h3><div class="setting-row"><strong>客户端版本</strong><span>0.1.0 · 设计基线</span></div><div class="setting-row"><strong>线上服务 / 协议</strong>${badge('状态示例')}</div><p class="hint" style="margin:16px 0">导出只包含版本、连接、模式和数量等原脱敏字段。不会增加账号名、设备标识、模型地址、模型名、提示词或密钥。</p>${button('导出脱敏诊断信息','diagnostics','primary')}</div><div class="notice">安装包签名、自动更新与线上可用性沿用原发布门槛；这个设计原型不代表生产验收。</div>`;
}
function openLocalSettings() {
  openModal('客户端设置',`<div class="settings-layout"><nav class="settings-nav" aria-label="客户端设置分类"><div class="nav-label">此设备</div>${localTabs.map((label,i)=>`<button class="nav-item ${label===state.localTab?'active':''}" data-local-tab="${label}">${icon(['activity','settings','shield','panel','user','shield','file'][i])}<span>${label}</span></button>`).join('')}</nav><section class="settings-content" id="local-settings-content">${localSettingsBody()}</section></div>`, '', 'local-settings');
  const choice=$('#mode-choice');if(choice)choice.value=state.mode==='server'?'服务器 AI':'此客户端 AI';
}
function searchView() { return `<div class="page">${pageTop('搜索','在当前工作区的作品、选题、素材和风格样本中查找。')}<div class="filters"><div class="input-wrap">${icon('search')}<input aria-label="完整搜索关键词" placeholder="输入关键词，例如：时间" id="full-search"></div><select aria-label="搜索类型"><option>全部类型</option><option>作品</option><option>选题</option><option>素材</option><option>风格样本</option></select><select aria-label="搜索账号"><option>全部账号</option><option>知行笔记</option></select><select aria-label="搜索时间"><option>全部时间</option><option>近 7 天</option><option>近 30 天</option></select></div><div class="panel" id="search-results">${works.slice(0,3).map(w=>`<article class="topic-row"><div class="meta">${badge('作品')}<span>知行笔记</span></div><h3><button class="text-button" data-nav="editor" style="color:var(--text);font-size:14px">${w.title}</button></h3><p>${baseParagraphs[0]}</p></article>`).join('')}</div></div>`; }
function shareView() { return `<div class="page">${pageTop('保存分享内容','把文字或链接先存下来，之后再逐条整理。')}<form id="share-form" class="settings-card" style="max-width:650px">${fieldHTML('保存到',['灵感收件箱','素材库'],'text','share-destination')}${fieldHTML('素材类型',['案例','经历','观点','数据'])}<label class="field">内容<textarea rows="7" id="share-text" required placeholder="粘贴分享的文字或链接"></textarea></label><button class="button primary" type="submit">保存这一条（演示）</button></form></div>`; }
function authView() { const register=state.page==='register',setup=state.page==='setup';return `<div class="page"><form id="auth-form" class="panel auth-panel"><div class="eyebrow">OPS 灵感空间 · 设计预览</div><h1>${setup?'开始你的工作区':register?'创建账号':'欢迎回来'}</h1><p>${setup?'完成首次初始化后，进入平台账号设置。':register?'使用邀请码加入工作区，或按原流程创建自己的工作区。':'登录后，继续你还没写完的内容。'}</p>${fieldHTML('账号','','text','auth-name')}${fieldHTML('密码（仅演示，请勿填真实密码）','','password','auth-password')}${register?fieldHTML('邀请码（按原规则选填或必填）','','text','auth-code'):''}${setup?fieldHTML('工作区名称','','text','auth-workspace'):''}<button class="button primary" type="submit">${register?'注册':setup?'创建工作区':'登录'}（演示）</button><div class="actions" style="margin-top:17px"><button class="text-button" type="button" data-nav="${register?'login':'register'}">${register?'返回登录':'注册账号'}</button><button class="text-button" type="button" data-nav="setup">首次初始化示例</button></div></form></div>`; }

function render() {
  renderSidebar();
  const info=pageInfo[state.page];
  $('#breadcrumb-group').textContent=info.group;$('#breadcrumb-page').textContent=info.label;$('#window-page').textContent=info.label;
  const views={home:homeView,works:worksView,editor:editorView,agent:agentView,topics:topicsView,calendar:calendarView,materials:materialsView,images:imagesView,ops:opsView,review:reviewView,profile:profileView,settings:settingsView,search:searchView,share:shareView,login:authView,register:authView,setup:authView,public:()=>`<div class="page"><div class="notice">公开预览布局示意；真实版本仍按原 token 和权限由公开路由提供。</div><article class="paper preview-document"><div class="document-meta">知行笔记 · 公开预览</div><h1>${workTitle}</h1>${baseParagraphs.map(p=>`<p>${p}</p>`).join('')}</article></div>`};
  $('#view').innerHTML=views[state.page]();
  $('#view').classList.remove('view-enter');void $('#view').offsetWidth;$('#view').classList.add('view-enter');
  $('#go-back').disabled=state.history.length===0;
  $('#ai-status').textContent=state.mode==='server'?'服务器 AI':`此客户端 AI · ${state.channel?'已连接':'通道未连接'}`;
  $('#service-label').textContent=state.status==='offline'?'线上服务不可达':'工作区在线';
  $('#service-dot').style.background=state.status==='offline'?'var(--danger)':'var(--success)';
}
function openModal(title,body,footer='',className='') {
  const modal=$('#modal');
  modal.setAttribute('aria-labelledby','modal-title');modal.removeAttribute('aria-label');
  if(!modal.open)modalTrigger=document.activeElement;
  modal.className=className;
  $('#modal-content').innerHTML=`<div class="modal-header"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭对话框">${icon('close')}</button></div><div class="modal-body">${body}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}`;
  if(!modal.open)modal.showModal();
  modal.classList.add('modal-open');
  requestAnimationFrame(()=>{const first=$('[autofocus]',modal)||$('input:not([type="hidden"]),textarea,select,button',modal);if(first)first.focus();});
}
function confirmDemo(title,body,confirmLabel='确认（演示）',action='confirm-generic',danger=false) {
  openModal(title,body,button('取消','close-modal','', 'autofocus')+button(confirmLabel,action,danger?'danger':'human'));
}
function showDetail(title,desc,extra='') { openModal(title,`<p>${desc}</p>${extra}<div class="notice blue">设计交互示例：此操作不连接业务接口，不修改真实数据。</div>`,button('返回','close-modal')); }
function palette() {
  const modal=$('#modal');if(!modal.open)modalTrigger=document.activeElement;
  modal.className='palette';
  $('#modal-content').innerHTML=`<div class="palette-search">${icon('search')}<input id="palette-input" aria-label="搜索页面、设置或命令" placeholder="搜索页面、设置或最近的作品…" autocomplete="off"><kbd>Esc</kbd></div><div class="palette-results" id="palette-results"></div><div class="palette-caption"><span>↑ ↓ 选择　Enter 打开　Esc 关闭</span><span>写入操作仍需到页面确认</span></div>`;
  if(!modal.open)modal.showModal();
  // 设计面板使用自己的可访问名称；关闭后其他模态框会恢复标题。
  modal.setAttribute('aria-label','搜索与命令');modal.removeAttribute('aria-labelledby');
  paletteResults('');$('#palette-input').focus();
}
function paletteResults(query) {
  const entries=[...Object.entries(pageInfo).filter(([id])=>!['public','setup','register'].includes(id)).map(([id,info])=>({label:info.label,group:info.group,nav:id,glyph:info.glyph||'file'})),{label:workTitle,group:'最近作品',nav:'editor',glyph:'file'},{label:'客户端设置',group:'此设备',action:'desktop-settings',glyph:'settings'},...settingGroups.flatMap(([,names])=>names.map(label=>({label,group:'工作区设置',setting:label,glyph:'settings'}))),{label:'发布前检查',group:'当前作品',action:'go-check',glyph:'shield'},{label:'减少动态效果',group:'个人偏好',action:'motion',glyph:'activity'}];
  const matches=entries.filter(e=>(e.label+e.group).includes(query.trim()));
  $('#palette-results').innerHTML=matches.length?matches.map(e=>`<button ${e.nav?`data-nav="${e.nav}"`:e.setting?`data-setting="${e.setting}"`:`data-action="${e.action}"`}>${icon(e.glyph)}<span>${e.label}</span><small>${e.group}</small></button>`).join(''):'<div class="empty">没有匹配结果</div>';
}

function savePrototypeEditor() {
  const editor=$('#editable-body');if(editor)state.editorText=editor.innerHTML;
  state.checkDone.clear();state.checkChoices={};
  clearTimeout(saveTimer);$('#save-status').textContent='正在保存到本次预览…';
  saveTimer=setTimeout(()=>{$('#save-status').textContent='已保存到本次预览 · 未写入业务系统';},700);
}
function sendChat() {
  const input=$('#chat-input');if(!input || state.busy || !input.value.trim())return;
  const text=input.value.trim();
  state.agentMessages.push({role:'user',text},{role:'assistant',text:'',streaming:true});state.busy=true;
  render();
  const answer='可以把方向再收窄一点：先选一个真实场景，说明当时的困扰、你做了什么调整，以及结果。这里是原型的流式回复演示，没有调用真实模型，也没有写入选题或作品。';
  let position=0;
  streamTimer=setInterval(()=>{
    position+=3;
    const msg=state.agentMessages[state.agentMessages.length-1];
    if(!msg || !state.busy){clearInterval(streamTimer);return;}
    msg.text=answer.slice(0,position);
    const output=$('#stream-response');if(output)output.textContent=msg.text;
    const stream=$('#chat-stream');if(stream && stream.scrollHeight-stream.scrollTop-stream.clientHeight<240)stream.scrollTop=stream.scrollHeight;
    if(position>=answer.length){clearInterval(streamTimer);msg.streaming=false;state.busy=false;if(state.page==='agent'){const scroll=stream.scrollTop;render();$('#chat-stream').scrollTop=scroll;}}
  },55);
}
function stateExamples() {
  openModal('界面状态示例',`<p>选择一个状态，查看它如何呈现。切换只改变原型，不会切断网络或执行业务。</p><div class="actions">${[['加载中','loading'],['空状态','empty'],['保存失败','save-error'],['修订冲突','conflict'],['线上不可达','offline'],['无权限','forbidden'],['会话过期','expired'],['版本不兼容','incompatible']].map(([label,id])=>`<button class="button" data-state-demo="${id}">${label}</button>`).join('')}</div>`);
}
function showState(kind) {
  if($('#modal').open)$('#modal').close();
  if(['save-error','conflict'].includes(kind)) {state.workTab='编辑';navigate('editor');}
  const scenarios={
    loading:['正在准备工作区','加载过程不会阻塞窗口菜单。请求超过短等待时间后显示占位，不显示虚构的百分比。'],
    empty:['还没有作品','从一条选题开始，或创建一篇空白作品。单篇旧文导入仍保留。'],
    'save-error':['这一段尚未保存','连接暂时中断。本次输入仍留在编辑区；正式版本保留本地草稿和人工重试。'],
    conflict:['检测到另一个修订版本','你的内容和服务器上的版本不同。先比较两个版本，再选择保留方式；不能静默覆盖。'],
    offline:['线上服务暂时不可达','可以重试、打开本地设置或导出诊断。已有缓存不代表可离线执行业务，客户端模式也不会静默切换到服务器。'],
    forbidden:['你当前只有查看权限','可以阅读内容。编辑、执行写入卡片和相关管理操作依原角色权限禁用。'],
    expired:['登录状态已过期','请先重新登录。重新认证与模型密钥配置仍分别处理；未保存编辑不应因错误提示消失。'],
    incompatible:['客户端与服务协议暂不兼容','保留当前已应用模式，先完成版本与服务检查。未经明确选择，不改用服务器 AI。']
  };
  const [title,desc]=scenarios[kind];
  if(kind==='offline'){state.status='offline';$('#service-label').textContent='线上服务不可达';$('#service-dot').style.background='var(--danger)';}
  if(kind==='save-error')$('#save-status').textContent='保存失败 · 草稿保留 · 请重试';
  const body=`<div class="notice ${['loading','empty'].includes(kind)?'blue':'red'}">${desc}</div>${kind==='loading'?'<span class="loading-mark">正在加载（示意）</span><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:65%"></div><div class="skeleton" style="width:90%"></div>':''}${kind==='conflict'?`<div class="field-grid"><div class="settings-card"><h3>本机草稿</h3><p>${baseParagraphs[0]}</p></div><div class="settings-card"><h3>服务器修订</h3><p>先确定重要的事，再安排自己的时间。</p></div></div>`:''}`;
  openModal(title,body,button('返回并保留内容','close-modal')+(kind==='offline'?button('客户端设置','desktop-settings'):kind==='expired'?button('去登录','login-page','primary'):kind==='empty'?button('新建作品','new-work','primary'):kind==='conflict'?button('选择合并方式','merge-versions','human'):button('重试（演示）','retry-state','primary')),kind==='conflict'?'wide':'');
}
const detailActions={
  'work-history':['版本历史','原版本时间、作者、检查/发布节点与恢复能力都保留。', '<div class="settings-card"><div class="setting-row"><span>今天 10:24 · 当前修订</span>'+badge('当前','blue')+'</div><div class="setting-row"><span>今天 09:48 · 分段写作</span>'+button('比较版本','compare-versions','small')+'</div><div class="setting-row"><span>昨天 18:21 · 大纲确认</span>'+button('查看版本','compare-versions','small')+'</div></div>'],
  'work-properties':['作品属性与关系','保留负责人、审阅开关、计划发布日、源/派生树与系列关联。',fieldHTML('负责人',['林知','陈禾'])+fieldHTML('计划发布日','2026-10-18','date')+checkRow('发布前需要审阅',false)],
  'images-tools':['标题、摘要与配图','保留标题候选、拒绝原因、摘要/话题、图片上传、生成、图库与封面裁剪。',fieldHTML('标题',workTitle)+'<label class="field">摘要<textarea rows="3">把时间管理变成一次主动的选择。</textarea></label><div class="actions">'+button('从图片库选择','open-images','small')+button('封面裁剪','crop-cover','small')+'</div>'],
  'viewpoint':['核心观点','观点仍由你输入或查看建议后确认，不因界面改版而自动采纳。','<label class="field">观点<textarea rows="3">时间管理的起点，是先确认什么对自己真正重要。</textarea></label>'],
  'outline':['已确认大纲','保留大纲生成、手动编辑、确认与修改后的段落处理。当前示例处于已确认状态。','<div class="notice">从忙碌中停一下 → 给重要的事留白 → 把选择权拿回来 → 从今天的小事开始</div>'],
  'variants':['本段候选','保留单候选/三候选选择、拒绝反馈与采纳。采纳之前不会覆盖原段落。',baseParagraphs.map((p,i)=>'<article class="source-card"><strong>候选 '+(i+1)+'</strong><p>'+p+'</p>'+button('采纳这一版','adopt-variant','small')+'</article>').join('')],
  'materials-picker':['选择参考素材','只列出本账号与工作区共享素材。逐条关联，保留出处。',topicSamples.slice(0,2).map(t=>'<div class="setting-row"><span>'+t+'</span>'+button('关联这条素材','reference','small')+'</div>').join('')],
  'inbox-picker':['从收件箱整理','单条确认类型、来源和共享范围，可选择关联到当前作品。不会自动把所有条目入库。','<label class="field">素材内容<textarea rows="4">周末散步时想到：不安排的时间，也可能最有价值。</textarea></label>'+fieldHTML('类型',['经历','观点','案例','数据'])],
  'derive':['派生与作品关系','保留源作品、衍生平台账号、需要同步提示与派生后的编辑入口。',fieldHTML('目标平台账号',['知行日常 · 小红书 · 图文卡片'])],
  'check-report':['发布前检查报告','独立报告仍保留原检查分类、状态、修订号与出处；不省略服务端检查或审阅。','<div class="settings-card">事实核实 / 敏感词 / AI 声明 / 格式 / 同质化 / 广告法 / 数据过期</div>'],
  'pack-share':['发布包分享与二维码','保留原分享链接、二维码、权限和移动查看流程。这个原型不创建可用的公开链接。','<div class="notice">真实版本继续使用现有 token 与分享数据。</div>'],
  'agent-options':['对话设置','保留每个对话的模型、操作账号、隐私、用量、摘要和历史管理。',fieldHTML('本对话使用模型',['标准模型','高质量模型'])+fieldHTML('操作账号',['知行笔记 · 公众号','知行日常 · 小红书','不指定账号'])+'<div class="actions">'+button('查看附件与用量','agent-usage','small')+button('重命名 / 删除对话','conversation-options','small')+button('重新生成 / 编辑消息','regenerate-options','small')+'</div>'],
  'notifications':['通知','保留待办、任务结果、已读状态与原通知来源。','<div class="setting-row"><span>一篇作品等待审阅</span>'+button('查看','review-work','small')+'</div><div class="setting-row"><span>两篇作品需要回填</span>'+button('回填','backfill','small')+'</div>'],
  'backfill':['回填已发布信息','在平台完成发布后，由你确认发布链接与时间。不会自动标记发表。',fieldHTML('发布链接','','url')+fieldHTML('发布时间','2026-10-16T10:30','datetime-local')],
  'route-detail':['任务主备用与辅助能力','保留每个任务的执行位置、主模型、备用模型和能力约束；默认任务必须有效，向量检索只在服务器执行。',fieldHTML('任务',['分段起草','智能体对话','图片生成'])+fieldHTML('主模型',['服务器标准模型','本机写作模型'])+fieldHTML('备用位置',['不启用备用','服务器','此客户端'])+fieldHTML('备用模型',['请选择匹配能力的模型'])],
  'material-detail':['编辑素材','保留类型、正文、来源、有效期和共享范围。',fieldHTML('素材类型',['经历','观点','案例','数据'])+'<label class="field">内容<textarea rows="4">'+baseParagraphs[1]+'</textarea></label>'+fieldHTML('来源','林知的生活笔记')+fieldHTML('有效期','','date')+checkRow('工作区共享',false)],
  'review-data':['录入作品数据','保留作品、采样日期、阅读/收藏/分享等平台适用指标。',fieldHTML('作品',works.map(w=>w.title))+fieldHTML('记录日期','2026-10-16','date')+fieldHTML('阅读量','2864','number')],
  'ops-questionnaire':['起号问卷','保留领域、真实经历与资源、受众、目标、投入时间、形态和旧作品，生成方案后仍需你选择与启用。',fieldHTML('想做的领域','生活观察')+fieldHTML('想吸引谁','希望重新掌握生活节奏的人')+fieldHTML('每周投入时间（小时）','6','number')],
  'ops-history':['运营方案版本','保留版本预览、调整意见、恢复和明确启用动作。','<div class="settings-card"><p>第 3 版 · 当前启用</p><p>第 2 版 · 10 月 12 日</p>'+button('预览这一版','ops-detail','small')+button('确认恢复这一版','restore-strategy','human small')+'</div>'],
};

function handleAction(action,el) {
  if(action==='creative-inbox'){state.topicTab='收件箱';navigate('topics');return;}
  if(action==='creative-daily'){state.opsTab='每日推荐';navigate('ops');return;}
  if(action==='creative-usage'){state.settingTab='AI 用量与成本';navigate('settings');return;}
  if(action==='creative-health'){navigate('profile');return;}
  if(action==='creative-new-chat'){state.agentMessages=[];state.cards.clear();navigate('agent');toast('已打开新对话的布局示例；未创建真实对话。');return;}

  if(action==='close-modal'){$('#modal').close();return;}
  if(action==='theme'){state.theme=state.theme==='light'?'dark':'light';applyPreferences();if(state.page==='settings')$('#workspace-settings-content').innerHTML=settingsBody();return;}
  if(action==='motion'){state.reduced=!state.reduced;applyPreferences();toast(state.reduced?'已减少动态效果；系统偏好始终优先。':'已使用轻快动效；仍尊重系统减少动态效果偏好。');return;}
  if(action==='workspace-settings'){navigate('settings');return;}
  if(action==='members-shortcut'){state.settingTab='成员与邀请';navigate('settings');return;}
  if(action==='desktop-settings'){openLocalSettings();return;}
  if(action==='continue'){state.workTab='编辑';navigate('editor');return;}
  if(action==='go-check'){state.workTab='发布前检查';navigate('editor');render();return;}
  if(action==='go-publish'){state.workTab=state.account==='wx'?'公众号草稿':'小红书发布包';render();return;}
  if(action==='open-images'){navigate('images');return;}
  if(action==='open-calendar'){navigate('calendar');return;}
  if(action==='login-page'){navigate('login');return;}
  if(action==='focus'){state.focus=!state.focus;$('#view .editor').classList.toggle('focus-mode',state.focus);return;}
  if(action==='preview-states'){stateExamples();return;}
  if(action==='send-chat'){sendChat();return;}
  if(action==='stop-chat'){clearInterval(streamTimer);state.busy=false;const m=state.agentMessages.at(-1);if(m&&m.streaming){m.text+='（已停止）';m.streaming=false;}render();return;}
  if(action==='channel'){state.channel=!state.channel;openLocalSettings();$('#ai-status').textContent=state.mode==='server'?'服务器 AI':`此客户端 AI · ${state.channel?'已连接':'通道未连接'}`;toast(state.channel?'已模拟连接 WSS；未调用模型，也未运行能力自检。':'已模拟断开通道；模式不变，不自动回退服务器。');return;}
  if(action==='selftest'){confirmDemo('启动模型能力自检','<p>真实版本将调用选定模型，可能产生费用。本原型仅演示结果，不进行网络调用。</p>','开始自检（演示）','confirm-selftest');return;}
  if(action==='confirm-selftest'){state.tested=true;state.localTab='能力自检';openLocalSettings();toast('自检演示完成：文本、JSON、工具调用通过；看图和图片生成未测试。');return;}
  if(action==='save-map'){state.draftMap=true;openLocalSettings();toast('已保存本机映射草稿（演示），仍需确认应用模式。');return;}
  if(action==='apply-mode'){
    const target=$('#mode-choice').value==='此客户端 AI'?'desktop':'server';
    if(target==='desktop'&&(!state.modelSaved||!state.channel||!state.tested||!state.draftMap)){openModal('还不能启用此客户端 AI','<p>请先保存本机模型、连接通道、主动运行能力自检，并保存有效任务映射草稿。</p><div class="notice amber">这里按原工作流展示门槛，不会因界面切换跳过配置或确认。</div>',button('返回客户端设置','desktop-settings'));return;}
    state.pendingMode=target;confirmDemo('应用'+(target==='server'?'服务器 AI':'此客户端 AI'),'先保存业务页面内容。真实版本确认后会重新加载业务页；只影响后续任务，不会把失败请求自动转发到其他模式。','确认应用（演示）','confirm-mode');return;
  }
  if(action==='confirm-mode'){state.mode=state.pendingMode;state.appliedMap=state.draftMap;state.localTab='连接与模式';$('#modal').close();render();openLocalSettings();toast('执行模式已在原型中切换，没有刷新或改变真实客户端。');return;}
  if(action==='new-work'){openModal('新建作品',fieldHTML('作品标题','未命名作品','text','new-work-title')+fieldHTML('作品形态',['长图文','图文卡片','漫画分镜'],'text','new-work-shape')+'<div class="notice">这里只创建预览状态，不自动确认观点或大纲。</div>',button('取消','close-modal')+button('进入编辑器（演示）','create-work','primary'));return;}
  if(action==='create-work'){state.shape={'长图文':'article','图文卡片':'cards','漫画分镜':'comic'}[$('#new-work-shape').value];state.workTab='编辑';navigate('editor');toast('已进入所选形态的布局示例；真实新建流程仍需接回原接口。');return;}
  if(action==='shape'){openModal('作品形态布局示例','<p>仅为比较已有编辑器的设计。真实作品仍依据平台账号固定的内容形态打开，不能任意修改账号类型。</p><div class="actions">'+[['article','长文编辑器'],['cards','图文卡片'],['comic','漫画分镜']].map(([id,label])=>`<button class="button" data-shape="${id}">${label}</button>`).join('')+'</div>');return;}
  if(action==='collect'){openModal('快速收集','<form id="collect-form"><label class="field">想法或素材<textarea id="collect-text" rows="5" required placeholder="先把这一刻的想法记下来…"></textarea></label>'+fieldHTML('保存位置',['灵感收件箱','素材库'],'text','collect-destination')+'<button class="button primary" type="submit">保存这一条（演示）</button></form><div style="margin-top:18px">'+button('查看分享接收页','open-share','ghost small')+'</div>');return;}
  if(action==='open-share'){navigate('share');return;}
  if(action==='new-topic'||action==='new-material'){showDetail(action==='new-topic'?'添加一条选题':'添加一条素材','单条录入、来源和类型仍由用户决定。',fieldHTML('标题','')+'<label class="field">内容<textarea rows="4"></textarea></label>');return;}
  if(action==='adopt-write'){state.workTab='编辑';navigate('editor');toast('已演示「采用并开始写」；没有自动填观点、确认大纲或起草正文。');return;}
  if(action==='adopt'){el.textContent='已采用（演示）';el.disabled=true;return;}
  if(action==='drop-topic'){confirmDemo('放弃这一条选题','正式版本保留原成功后的撤销入口和十秒窗口。只处理当前选题。','放弃这一条（演示）','confirm-drop');return;}
  if(action==='confirm-drop'){$('#modal').close();toast('已演示放弃状态；正式版本保留撤销。');return;}
  if(action==='review-work'){state.workTab='发布前检查';navigate('editor');toast('已进入检查与审阅布局；真实审阅权仍按角色和负责人校验。');return;}
  if(action==='publish-demo'){confirmDemo(state.account==='wx'?'写入公众号草稿箱':'生成小红书发布包','<p>这是最终人工确认位置。真实版本还会校验服务端检查/审阅结果，必要时让你选择覆盖或另建。</p><div class="notice amber">当前只演示确认框，不调用微信、不生成发布包、不发布内容。</div>','确认（仅演示）','confirm-publish');return;}
  if(action==='confirm-publish'){$('#modal').close();toast('已演示确认后的结果提示；没有执行任何发布衔接。');return;}
  if(action==='tools'){openModal('作品工具',`<div class="tabs">${['素材','助手','待核实','评论'].map(t=>`<button data-modal-tool="${t}" class="${state.tool===t?'active':''}">${t}</button>`).join('')}</div><div style="padding-top:14px">${toolContent()}</div><div class="actions">${button('润色与通读','assistant-tool','small')}${button('活动记录','activity','small')}</div>`);return;}
  if(action==='reference'){toast('已演示关联当前段落；素材引用和来源会保留。');return;}
  if(action==='rewrite-section'||action==='continue-section'||action==='draft-section'){showDetail(action==='draft-section'?'起草这一段':'本段生成建议','只操作当前段落，候选先展示给你，不直接覆盖正文。','<div class="source-card"><p>也许我们需要的不是更多时间，而是为重要的事作出更明确的选择。</p>'+button('采纳这一版','adopt-variant','human small')+'</div>');return;}
  if(action==='adopt-variant'){state.editorText='<p>也许我们需要的不是更多时间，而是为重要的事作出更明确的选择。</p>';$('#modal').close();if(state.page==='editor')render();savePrototypeEditor();return;}
  if(action==='comment'){if(!$('#comment-input').value.trim()){toast('请先填写评论内容。');return;}toast('已演示发送单条评论，没有写入真实作品。');return;}
  if(action==='locate'){if($('#modal').open)$('#modal').close();$('#section-0')?.scrollIntoView({block:'start',behavior:'auto'});return;}
  if(action==='reauth'){showDetail('账号重新认证','密码仅用于本次认证，不保存。示例中请勿填写真实密码。',fieldHTML('当前账号密码','','password'));return;}
  if(['clear-local','revoke-device','delete-local-model'].includes(action)){confirmDemo(action==='clear-local'?'清除此账号本机数据':action==='revoke-device'?'撤销本人设备':'删除本机模型配置','此操作在真实版本中会影响当前账号的本机 AI 可用性，需要二次确认。HTML 只展示确认步骤，不删除数据。','确认（仅演示）','confirm-danger',true);return;}
  if(action==='confirm-danger'){$('#modal').close();toast('已展示危险操作的二次确认，没有删除或撤销任何真实数据。');return;}
  if(action==='retry-state'){state.status='online';$('#service-label').textContent='工作区在线';$('#service-dot').style.background='var(--success)';$('#save-status').textContent='示例数据 · 操作仅在本次预览中生效';$('#modal').close();toast('已恢复原型的正常状态。');return;}
  if(action==='merge-versions'){showDetail('选择版本处理方式','正式版本需逐段比较后确认，不静默覆盖。原型中可保留当前输入返回编辑。','<div class="actions">'+button('保留当前草稿并返回','close-modal','human')+button('查看修订历史','work-history')+'</div>');return;}
  if(action==='schedule'){openModal('计划发布日',fieldHTML('选择日期','2026-10-18','date','schedule-date')+'<p>日期只用于提醒，不自动推送或发布。</p>',button('取消','close-modal')+button('保存排期（演示）','save-schedule','primary'));return;}
  if(action==='save-schedule'){state.selectedDate=$('#schedule-date').value;$('#modal').close();toast('已演示设置计划日 '+state.selectedDate+'；不会自动发布。');return;}
  if(action==='import'){showDetail('单篇导入旧文','粘贴 Markdown 或公众号复制的富文本，先预览分段，再人工确认导入为已发布作品。保留可选日期；不抓链接、不导入多篇。',fieldHTML('作品标题','')+'<label class="field">正文<textarea rows="5" placeholder="粘贴一篇已有作品"></textarea></label>'+button('预览分段','import-preview','small'));return;}
  if(action==='work-more'){openModal('作品操作','<div class="actions">'+button('作品属性 / 负责人','work-properties')+button('版本历史','work-history')+button('源 / 派生关系','derive')+button('导出 Markdown','export-markdown')+button('导出 HTML','export-html')+button('复制为新草稿','duplicate-work')+button('单篇标签','work-tags')+button('已发布解锁编辑','unlock-work')+'</div>');return;}
  if(action==='status'){showDetail('当前连接状态','工作区：线上服务；模型执行位置：'+(state.mode==='server'?'服务器 AI':'此客户端 AI')+'。客户端 AI 通道：'+(state.channel?'已连接（演示）':'未连接（演示）')+'。连接不等于能力自检通过。');return;}
  if(action==='attach'){openModal('添加附件（设计示例）','<p>真实版本保留图片与 txt/md 上传、大小/数量限制、失败与移除。示例不读取文件。</p><div class="actions">'+button('加入示例图片','attach-sample-image')+button('加入示例文本','attach-sample-text')+'</div>');return;}
  if(action.startsWith('attach-sample-')){$('#modal').close();$('#attachments').innerHTML='<span class="attachment">'+icon('paperclip')+(action.endsWith('image')?'示例图片.png':'写作笔记.md')+'<button data-action="remove-attachment" aria-label="移除附件">×</button></span>';return;}
  if(action==='remove-attachment'){$('#attachments').innerHTML='';return;}
  if(action==='new-local-model'){state.modelSaved=false;openLocalSettings();return;}
  if(action==='section-undo'||action==='section-redo'){document.execCommand(action==='section-undo'?'undo':'redo');savePrototypeEditor();return;}
  if(action==='card-result'){navigate('topics');return;}
  if(detailActions[action]){showDetail(...detailActions[action]);return;}
  const labels={
    'diagnostics':['脱敏诊断导出','真实版本使用原生保存对话框和原脱敏字段；这里不生成文件。'],
    'save-settings':['保存个人偏好','真实版本保留原有偏好与保存行为。原型中的主题和动效选择已保存到当前浏览器。'],
    'setting-detail':[state.settingTab,'此页的原有新增、编辑、校验、删除、权限和错误流程均须接回；这里展示表单与反馈的设计。'],
    'calendar-week':['周视图','真实版本保留月/周切换；周视图按同一日期、事件和未排期面板展开，不新增自动发布。'],
    'calendar-month':['月视图','当前示例为月视图。实际月/周切换继续沿用现有日历功能。'],
    'calendar-prev':['上个月','原日历翻月行为保留。这个原型固定展示 2026 年 10 月作为审阅基准。'],
    'calendar-next':['下个月','原日历翻月行为保留。这个原型固定展示 2026 年 10 月作为审阅基准。'],
    'calendar-today':['回到本月','已定位到设计基准月：2026 年 10 月。'],
    'calendar-scope':['日历账号范围','原当前账号/全部账号范围切换保留，跨账号也不能改写数据权限。'],
    'topic-suggest':['AI 选题建议','原方向输入、生成、分页、停止、失败重试、逐条入库和忽略继续保留。'],
    'assistant-tool':['创作助手','保留润色、通读、候选预览与采纳，不自动覆盖当前文稿。'],
    'save-profile':['保存账号档案','示例只展示保存反馈，不更改账号类型、提示词、记忆或主题。'],
    'profile-detail':['账号档案详情','保留定位/样本/记忆的原操作和权限。记忆仍需逐条确认，漫画角色与公众号排版按形态显示。'],
    'review-screenshot':['截图识别','保留上传截图、识别、字段预览、人工校正和确认保存。'],
    'review-followers':['粉丝记录','保留人工记录与原数据来源。'],
    'review-match':['同步与匹配','保留待匹配文章逐条选择、忽略与数据同步。'],
    'review-report':['复盘报告','保留报告、引用证据、周草稿与建议逐条采纳。'],
    'review-trend':['数据趋势','保留原趋势分析与时间范围，使用同一图表外观与数据来源。'],
    'review-adopt':['采纳这一条复盘建议','采纳只处理当前建议，保留后续选题与写作的人工确认。'],
    'ops-detail':[state.opsTab,'保留此模块原有的编辑、来源、状态、历史与逐条采纳；不新增批量执行。'],
    'ops-generate':['准备运营参考','真实版本沿用原生成/停止/错误/选择流程；不会因切换页面而自动启用方案或采用选题。'],
    'storyboard':['角色与分镜','保留角色选择、核心观点、分镜确认、逐格旁白对白与配图。'],
    'reload-business':['重新加载业务页','真实客户端先提醒保存未提交编辑与当前任务数量。这里不刷新页面。'],
    'external-link':['打开微信公众平台','真实客户端按现有规则确认后用系统浏览器打开，不在本地特权窗口载入。'],
    'conversation':['对话列表','保留对话搜索、切换、重命名、删除与历史加载。此原型只展示一段固定对话。'],
    'activity':['活动记录','保留评论、协作在线、修改者与时间等原能力。'],
    'unlock-work':['解锁已发布作品','真实版本继续二次确认；修改只更新系统记录，不同步平台正文。'],
  };
  const detail=labels[action] || [el?.textContent.trim() || '操作示例','这个操作的原能力继续保留。当前只展示交互反馈，不执行真实业务。'];
  showDetail(...detail);
}

document.addEventListener('click',event=>{
  const el=event.target.closest('button,[data-date]');if(!el)return;
  if(el.dataset.nav){navigate(el.dataset.nav);return;}
  if(el.dataset.action){handleAction(el.dataset.action,el);return;}
  if(el.dataset.window){toast('「'+el.dataset.window+'」是窗口按钮示意；当前在浏览器中，不控制真实 Windows 窗口。');return;}
  if(el.dataset.menu){const menus={client:[['AI 连接设置','desktop-settings'],['重新登录','login-page'],['关于 OPS Desktop','about'],['退出客户端','quit-demo']],edit:[['撤销','section-undo'],['重做','section-redo'],['剪贴板操作说明','clipboard']],view:[['空间主题','theme'],['减少动态效果','motion'],['重新加载','reload-business'],['缩放说明','zoom-demo']]};openModal({client:'客户端',edit:'编辑',view:'视图'}[el.dataset.menu],'<div class="actions">'+menus[el.dataset.menu].map(([label,action])=>button(label,action)).join('')+'</div>');return;}
  if(el.dataset.filter){state.workFilter=el.dataset.filter;render();return;}
  if(el.dataset.star!==undefined){const i=Number(el.dataset.star);state.star.has(i)?state.star.delete(i):state.star.add(i);el.classList.toggle('on');el.textContent=state.star.has(i)?'★':'☆';el.setAttribute('aria-label',state.star.has(i)?'取消星标':'添加星标');return;}
  if(el.dataset.workTab){state.workTab=el.dataset.workTab;render();return;}
  if(el.dataset.section!==undefined){state.section=Number(el.dataset.section);$$('[data-section]').forEach(b=>b.classList.toggle('selected',b===el));$('#section-'+state.section)?.scrollIntoView({behavior:'auto',block:'start'});return;}
  if(el.dataset.tool){state.tool=el.dataset.tool;$$('[data-tool]').forEach(b=>b.classList.toggle('active',b===el));$('#tool-content').innerHTML=toolContent();return;}
  if(el.dataset.modalTool){state.tool=el.dataset.modalTool;handleAction('tools');return;}
  if(el.dataset.format){$('#editable-body').focus();document.execCommand(el.dataset.format);savePrototypeEditor();return;}
  if(el.dataset.shape){state.shape=el.dataset.shape;$('#modal').close();state.workTab='编辑';render();return;}
  if(el.dataset.check!==undefined){state.checkDone.add(Number(el.dataset.check));render();return;}
  if(el.dataset.cardPreview){const id=el.dataset.cardPreview;confirmDemo('预览这张选题操作卡片','<p>仅向「知行笔记」的选题池添加这一条，不生成观点、大纲或正文。</p><div class="settings-card"><strong>'+ (id==='topic-1'?'不再用忙碌证明自己':'每天留二十分钟给自己')+'</strong><p style="margin:10px 0 0">来源：账号定位、已确认写作记忆与你的方向。</p></div><div class="notice amber">只处理当前卡片；其他卡片仍等待你分别确认。</div>','确认执行这一张（演示）','execute-card');$('#modal').dataset.card=id;return;}
  if(el.dataset.cardReject){el.closest('.action-card').innerHTML='<div class="card-head">'+icon('close')+'<strong>已拒绝这一张卡片（演示）</strong></div><div class="card-body"><p>没有写入选题，其他卡片不受影响。</p></div>';return;}
  if(el.dataset.localTab){state.localTab=el.dataset.localTab;openLocalSettings();return;}
  if(el.dataset.setting){state.settingTab=el.dataset.setting;navigate('settings');return;}
  if(el.dataset.topicTab){state.topicTab=el.dataset.topicTab;render();return;}
  if(el.dataset.opsTab){state.opsTab=el.dataset.opsTab;render();return;}
  if(el.dataset.profileTab){state.profileTab=el.dataset.profileTab;render();return;}
  if(el.dataset.materialType){$$('[data-material-type]').forEach(b=>b.classList.toggle('active',b===el));$$('#material-list [data-kind]').forEach(row=>row.hidden=el.dataset.materialType!=='全部'&&row.dataset.kind!==el.dataset.materialType);return;}
  if(el.dataset.date){state.selectedDate=el.dataset.date;handleAction('schedule');$('#schedule-date').value=state.selectedDate;return;}
  if(el.dataset.image!==undefined){showDetail('图片详情与替代文字','保留查看原图、来源作品、复用、替代文字建议与人工保存。','<div class="image-art" style="aspect-ratio:2;border-radius:6px;margin-bottom:15px"><div class="art-window"><i></i><i></i><i></i></div></div><label class="field">替代文字<textarea rows="3">窗边的笔记本与一段安静的写作时间。</textarea></label><div class="actions">'+button('AI 建议（先填入编辑框）','alt-suggest','small')+button('保存替代文字（演示）','alt-save','primary small')+'</div>');return;}
  if(el.dataset.stateDemo){showState(el.dataset.stateDemo);}
});
// 逐张执行在主委托之前截取，避免落入通用示意动作。
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action="execute-card"]');if(!target)return;
  event.stopImmediatePropagation();const id=$('#modal').dataset.card;state.cards.add(id);$('#modal').close();render();toast('已执行当前这一张卡片（仅原型状态），其他卡片仍等待确认。');
},true);
document.addEventListener('input',event=>{
  if(event.target.id==='editable-body')savePrototypeEditor();
  if(event.target.id==='work-search'){state.query=event.target.value;$('#works-list').innerHTML=workRows();}
  if(event.target.id==='palette-input')paletteResults(event.target.value);
  if(event.target.id==='topic-search')$$('#topic-list .topic-row').forEach(row=>row.hidden=!row.textContent.includes(event.target.value));
  if(event.target.id==='material-search')$$('#material-list .topic-row').forEach(row=>row.hidden=!row.textContent.includes(event.target.value));
  if(event.target.id==='image-search')$$('.image-card').forEach(card=>card.hidden=!card.textContent.includes(event.target.value));
  if(event.target.id==='full-search')$$('#search-results .topic-row').forEach(row=>row.hidden=!row.textContent.includes(event.target.value));
  if(event.target.matches('.conversation-search'))$$('.conversation-list .nav-item').forEach(row=>row.hidden=!row.textContent.includes(event.target.value));
});
document.addEventListener('change',event=>{
  if(event.target.id==='reduce-motion-input'){state.reduced=event.target.checked;applyPreferences();}
  if(event.target.id==='tag-filter'){state.query=event.target.value;$('#work-search').value=state.query;$('#works-list').innerHTML=workRows();}
  if(event.target.dataset.checkChoice!==undefined){const i=Number(event.target.dataset.checkChoice);state.checkChoices[i]=event.target.value;$(`[data-check="${i}"]`).disabled=!event.target.value;}
  if(event.target.id==='article-size')$$('.preview-document p').forEach(p=>p.style.fontSize=event.target.value);
  if(event.target.id==='article-theme')$('.preview-document').style.borderTop='4px solid var(--accent)';
});
document.addEventListener('submit',event=>{
  event.preventDefault();
  if(event.target.id==='model-form'){
    const name=$('#local-model-name').value.trim(),models=$('#local-model-names').value.trim(),url=$('#local-base-url').value.trim();let valid=false;
    try{const u=new URL(url);valid=u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname);}catch{}
    if(!name||!models||!valid){$('#model-form-error').hidden=false;$('#model-form-error').textContent='请填写配置名称、模型名称，以及公网 HTTPS 或本机回环 API 地址。';return;}
    state.modelSaved=true;openLocalSettings();toast('已保存模型配置演示状态；没有存储 API Key、密码或连接真实模型。');
  }
  if(event.target.id==='collect-form'){const text=$('#collect-text').value.trim();if(!text)return;state.collect.unshift(text);$('#modal').close();toast('已保存一条预览内容，可到选题池「收件箱」查看；刷新后清除。');}
  if(event.target.id==='share-form'){const text=$('#share-text').value.trim();if(!text)return;state.collect.unshift(text);state.topicTab='收件箱';navigate('topics');toast('已保存到原型收件箱；真实分享接收仍按原流程接线。');}
  if(event.target.id==='auth-form'){navigate('home');toast('已进入设计工作台；没有发送账号或密码，也没有创建真实会话。');}
});
document.addEventListener('keydown',event=>{
  if(event.isComposing||event.keyCode===229)return;
  const typing=event.target.closest('input,textarea,select,[contenteditable="true"]');
  if(event.ctrlKey&&event.key.toLowerCase()==='k'){event.preventDefault();$('#modal').open?$('#modal').close():palette();return;}
  if(event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();if(state.page==='editor')savePrototypeEditor();else toast('保存快捷键示意；真实版本保留各页面的原保存行为。');return;}
  if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='f'){event.preventDefault();if(state.page==='editor')handleAction('focus');return;}
  if(event.target.id==='chat-input'&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();return;}
  if($('#modal').open && $('#modal').classList.contains('palette')){
    const results=$$('#palette-results button'),index=results.indexOf(document.activeElement);
    if(event.key==='ArrowDown'){event.preventDefault();results[(index+1)%results.length]?.focus();}
    if(event.key==='ArrowUp'){event.preventDefault();results[(index+results.length-1)%results.length]?.focus();}
    if(event.key==='Enter'&&event.target.id==='palette-input'){event.preventDefault();results[0]?.click();}
    return;
  }
  if(typing || event.ctrlKey || event.altKey || event.metaKey || $('#modal').open)return;
  if(event.key==='?'){event.preventDefault();showDetail('键盘快捷键','Ctrl+K 搜索与命令；Ctrl+S 保存；Ctrl+Shift+F 专注；G D 工作台、G T 选题、G C 日历、G W 作品、G M 素材、G R 复盘。输入法组合期间不会触发 Enter 发送。');return;}
  if(event.key.toLowerCase()==='g'){gPending=Date.now();return;}
  if(gPending && Date.now()-gPending<1200){gPending=0;const page={d:'home',t:'topics',c:'calendar',w:'works',m:'materials',r:'review'}[event.key.toLowerCase()];if(page)navigate(page);}
});
$('#modal').addEventListener('close',()=>{const trigger=modalTrigger;requestAnimationFrame(()=>{if(!$('#modal').open && trigger?.isConnected)trigger.focus({preventScroll:true});});});
$('#modal').addEventListener('click',event=>{if(event.target!==$('#modal'))return;const r=$('#modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('#modal').close();});
$('#theme-toggle').addEventListener('click',()=>handleAction('theme'));
$('#collapse-nav').innerHTML=icon('panel');$('#collapse-nav').addEventListener('click',()=>{const expanded=$('#studio').classList.toggle('nav-collapsed');$('#collapse-nav').setAttribute('aria-label',expanded?'收起导航文字':'展开导航文字');$('#collapse-nav').setAttribute('aria-expanded',String(expanded));});
$('#go-back').innerHTML=icon('back');$('#go-back').addEventListener('click',()=>{const page=state.history.pop();if(page)navigate(page,{back:true});});
$('#search-trigger').addEventListener('click',palette);$('#search-icon').innerHTML=icon('search');$('#bell-icon').innerHTML=icon('bell');
$('#workspace-switch').addEventListener('click',()=>openModal('工作区','<p>保持当前工作区的身份、权限与数据隔离。</p><div class="setting-row"><span>知行内容工作区 · owner</span>'+badge('当前','green')+'</div><div class="actions" style="margin-top:16px">'+button('成员与邀请','members-shortcut')+button('切换 / 创建 / 加入工作区','workspace-options')+'</div>'));
$('#account-switch').addEventListener('click',()=>openModal('切换平台账号','<p>账号是创作上下文；切换后列表、档案和适用编辑器随账号变化。真实版本保留草稿与权限处理。</p><div class="actions"><button class="button" data-account="wx">公众号 · 知行笔记 · 长图文</button><button class="button" data-account="xhs">小红书 · 知行日常 · 图文卡片</button></div>'));
document.addEventListener('click',event=>{const el=event.target.closest('[data-account]');if(!el)return;state.account=el.dataset.account;$('#account-name').textContent=state.account==='wx'?'知行笔记':'知行日常';$('#account-type').textContent=state.account==='wx'?'公众号 · 长图文':'小红书 · 图文卡片';const mark=$('#account-switch .platform');mark.className='platform '+state.account;mark.textContent=state.account==='wx'?'公':'红';state.shape=state.account==='wx'?'article':'cards';state.workTab='编辑';state.profileTab='定位';state.checkDone.clear();state.checkChoices={};$('#modal').close();render();toast('已切换原型账号与适用编辑器。作品和统计仍为固定示例内容。');});
applyPreferences();render();
