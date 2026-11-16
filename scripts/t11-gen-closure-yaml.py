# -*- coding: utf-8 -*-
"""生成 docs/design/closure-blockers.yaml：51 条目，纯镜像不改状态。

数据源：docs/34 卡片状态行（四态现取）+ docs/design/closure-blocker-list.md
§2/§3/§4 行（missing / unblock / how）。本脚本是一次性生成器，不进产品链路。
"""
import re
import io

BS = chr(92)  # 反斜杠
QT = chr(34)  # 双引号

with io.open('docs/34-核心功能缺口任务拆分与完成度.md', encoding='utf-8') as f:
    t34 = f.read()
with io.open('docs/design/closure-blocker-list.md', encoding='utf-8') as f:
    bl = f.read()

GROUPS = [
    ('A', ['CF-DESK-02', 'CF-GATE-01', 'CF-TPL-01', 'CF-P2-QA-04', 'CF-PS-04',
           'CF-SKAG-03', 'CF-SKAG-04']),
    ('B', ['CF-CX-15', 'CF-AW-06', 'CF-PS-03', 'CF-PS-05', 'CF-P2-MEM-01',
           'CF-P2-MEM-02', 'CF-P2-MEM-03', 'CF-P2-CXEF-04', 'CF-P2-REL-01',
           'CF-P2-CA-02']),
    ('C', ['CF-DESK-03', 'CF-DESK-04', 'CF-DESK-05', 'CF-TPL-02', 'CF-TPL-03',
           'CF-TPL-04', 'CF-TPL-05', 'CF-TPL-06', 'CF-P2-MOBILE-02', 'CF-CX-18']),
    ('D', ['CF-PS-01', 'CF-PS-02', 'CF-P2-CXEF-02', 'CF-P2-BROWSER-01',
           'CF-P2-BROWSER-02', 'CF-P2-BROWSER-03', 'CF-P2-MOBILE-01',
           'CF-SKAG-01', 'CF-SKAG-02', 'CF-AW-07', 'CF-P2-CXEF-05',
           'CF-P2-VOICE-01', 'CF-P2-VOICE-02', 'CF-P2-QA-03',
           'CF-AW-08', 'CF-P2-REL-03', 'CF-P2-CA-03', 'CF-P2-MOBILE-03',
           'CF-GATE-03', 'CF-P2-EXT-02', 'CF-P2-CL-01', 'CF-P2-CL-02',
           'CF-P2-CL-03', 'CF-P2-CL-04']),
]

SEP = chr(0xFF5C)  # 全角竖线，34 卡片标题分隔符


def card(pid):
    m = re.search(r'(?m)^#{3,4}\s+' + re.escape(pid) + SEP, t34)
    assert m, pid + ': card not found'
    return t34[m.start():m.start() + 3000]


def card_row(pid, key):
    seg = card(pid)
    # 表头可能带粗体 **（如 **剩余** / **回退**），须容忍
    m = re.search(r'\|\s*\*{0,2}' + key + r'\*{0,2}[^|]*\|\s*([^|]+)\|', seg)
    return m.group(1).strip() if m else ''


def status_row(pid):
    return card_row(pid, '状态')


def bl_row_cells(pid):
    m = re.search(r'(?m)^\|\s*' + re.escape(pid) + r'\s*\|(.+)$', bl)
    if not m:
        return None
    return [c.strip() for c in m.group(1).split('|')]


def parse_status(pid):
    s = status_row(pid)
    m = re.match(r'`([a-z-]+)`\s*/\s*\*\*(\d+)\*\*', s)
    assert m, pid + ': status line unparsable: ' + s[:80]
    label, overall = m.group(1), int(m.group(2))
    # 「交」前可能有 Markdown 粗体 **（如 **交 0**），须容忍
    quads = re.findall(r'码\s*(\d+)\s*/\s*验\s*(\d+)\s*/\s*\*{0,2}\s*交\s*(\d+)', s)
    if quads:
        c, v, d = (int(x) for x in quads[-1])
    else:
        c, v, d = 0, 0, 0
    return label, c, v, d, overall


def strip_md(s):
    s = re.sub(r'\*\*([^*]+)\*\*', r'\1', s)
    s = s.replace('`', '')
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def yaml_str(s):
    s = s.replace(BS, BS + BS).replace(QT, BS + QT)
    return QT + s + QT


def bl_missing_how(pid, group):
    cells = bl_row_cells(pid)
    if cells and len(cells) >= 3:
        if group == 'B' and len(cells) >= 4:
            # §2.1 表：状态四态 | 本地已处理 | 缺什么 | 用户如何解除
            return strip_md(cells[2]), strip_md(cells[3])
        if group == 'C' and len(cells) >= 5:
            # §3 表：状态 | 前置 | 现取核验结论 | 用户如何解除
            return strip_md(cells[2]), strip_md(cells[3])
        if group == 'D' and len(cells) >= 4:
            # §4 表：状态 | 缺什么 | 用户如何解除
            return strip_md(cells[1]), strip_md(cells[2])
    return '', ''


# A 组 6 done 项与 B 组 2 伞项在阻塞清单只有判定句、无表行；
# 其「缺什么 / 如何解除」取 34 卡片「剩余」行（生成时点现取文本）。
BL_JUDGMENT_ONLY = {
    'CF-DESK-02': 'D-186 的 P1～P5 待用户批准（90 状态「提议」）',
    'CF-GATE-01': 'D-187 的 P1～P6 待用户批准（90 状态「提议」）；A 档「已交付」仅指本地机制',
    'CF-TPL-01': 'P1 文案统一 / P2 状态同步 / P3 TPL-02～06 范围重开，待用户确认或驳回（D-185「提议」）',
    'CF-P2-QA-04': '16 项真实外部条件 → 35 阻塞清单；32 项本地遗留不在 34/35 编号内，须另立编号',
    'CF-SKAG-03': '真模型 tools/vision 自检、E2E-23/25 人工复现、发布版本 HC-01～31 全量、C2～C4 部署确认',
    'CF-SKAG-04': '演练只覆盖配置层加载；真实部署 C2～C4 确认、HC 全量、真模型 E2E',
    'CF-CX-15': 'CF-P2-CXEF 五子项未达可关闭门槛（CXEF-02 blocked / 04 done-code 交 0 / 05 blocked）',
    'CF-AW-06': '真模型 / 物理环境 4 项外部阻塞 + 5 项共享 fixture 顺序耦合须另立编号（A22 类）',
}


lines = []
lines.append('# docs/design/closure-blockers.yaml')
lines.append('# CF-P2-DOC-01（T11，2026-11-12）：docs/design/closure-blocker-list.md 的机器可读镜像。')
lines.append('# 本文件不是事实源：冲突时以 docs/35 / docs/34 / docs/08 与阻塞清单 Markdown 为准。')
lines.append('# 字段固定：id / group / status / code / verify / deliver / missing / unblock / how。')
lines.append('# status 与四态为生成时点 docs/34 卡片现取值的镜像，本文件不更新状态；推进时仍以 Markdown 台账回写为准。')
lines.append('items:')
count = 0
for grp, lst in GROUPS:
    for pid in lst:
        label, c, v, d, overall = parse_status(pid)
        missing, how = bl_missing_how(pid, grp)
        cells = bl_row_cells(pid)
        unblock = ''
        if cells:
            if grp == 'C' and len(cells) >= 5:
                unblock = strip_md(cells[1])
            elif grp == 'B' and len(cells) >= 4:
                unblock = ''
        if not unblock:
            pre = card_row(pid, '前置')
            unblock = strip_md(pre) if pre else ''
        if not missing:
            rem = card_row(pid, '剩余')
            missing = strip_md(rem) if rem else ''
        if not missing:
            acc = card_row(pid, '验收')
            missing = strip_md(acc) if acc else ''
        if not missing:
            missing = BL_JUDGMENT_ONLY.get(pid, '')
        if not how:
            # CF-PS-04 在阻塞清单 §2.1 有表行但只有 3 个单元格（无「如何解除」列）；
            # 其解除路径与 34 卡片「剩余」行同源，兜底取 missing 同文。
            how = BL_JUDGMENT_ONLY.get(pid, '') or missing
        lines.append('  - id: ' + pid)
        lines.append('    group: ' + grp)
        lines.append('    status: ' + label)
        lines.append('    code: ' + str(c))
        lines.append('    verify: ' + str(v))
        lines.append('    deliver: ' + str(d))
        lines.append('    missing: ' + yaml_str(missing))
        lines.append('    unblock: ' + yaml_str(unblock))
        lines.append('    how: ' + yaml_str(how))
        count += 1
    lines.append('')

with io.open('docs/design/closure-blockers.yaml', 'w', encoding='utf-8', newline=chr(10)) as f:
    f.write(chr(10).join(lines) + chr(10))
print('items total:', count)
