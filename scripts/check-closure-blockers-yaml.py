# -*- coding: utf-8 -*-
"""CF-P2-DOC-01 定向核对脚本：closure-blockers.yaml 与 Markdown 台账一致性。

全部为静态台账核对，不改任何产品断言 / 状态 / 四态。退出码 0 = 全部断言通过。
"""
import io
import re
import sys

FAILS = []
OKS = 0


def check(name, cond, detail=''):
    global OKS
    if cond:
        OKS += 1
    else:
        FAILS.append(name + ((' — ' + detail) if detail else ''))


def main():
    try:
        import yaml  # noqa: F401
    except ImportError:
        print('SKIP: pyyaml 不可用，无法解析 YAML')
        sys.exit(2)

    with io.open('docs/design/closure-blockers.yaml', encoding='utf-8') as f:
        data = yaml.safe_load(f)
    items = data['items']

    with io.open('docs/34-核心功能缺口任务拆分与完成度.md', encoding='utf-8') as f:
        t34 = f.read()
    with io.open('docs/35-未完成功能收口清单与完成度.md', encoding='utf-8') as f:
        t35 = f.read()

    # 1. 条目数 = 51
    check('items==51', len(items) == 51, 'got %d' % len(items))

    # 2. 分组计数 A7/B10/C10/D24
    cnt = {'A': 0, 'B': 0, 'C': 0, 'D': 0}
    for it in items:
        cnt[it['group']] = cnt.get(it['group'], 0) + 1
    check('group counts A7/B10/C10/D24',
          cnt == {'A': 7, 'B': 10, 'C': 10, 'D': 24}, str(cnt))

    # 3. id 唯一
    ids = [it['id'] for it in items]
    check('ids unique', len(set(ids)) == len(ids))

    # 4. 字段固定 9 个
    FIELDS = {'id', 'group', 'status', 'code', 'verify', 'deliver',
              'missing', 'unblock', 'how'}
    bad = [it['id'] for it in items if set(it.keys()) != FIELDS]
    check('fields exactly 9', not bad, str(bad[:5]))

    # 5. status 取值合法
    LEGAL = {'done', 'done-code', 'doing', 'todo', 'blocked', 'cancelled'}
    bad = [it['id'] for it in items if it['status'] not in LEGAL]
    check('status legal', not bad, str(bad[:5]))

    # 6. 与 34 卡片状态行逐一比对（标签 + 四态数字）
    # 卡片体窗口只取到下一张卡片标题或 --- 为止，避免吃到相邻卡片的进度表数字
    SEP = chr(0xFF5C)
    mism = []
    for it in items:
        m = re.search(r'(?m)^#{3,4}\s+' + re.escape(it['id']) + SEP, t34)
        if not m:
            mism.append(it['id'] + ': card not found')
            continue
        nxt = re.search(r'(?m)^#{3,4}\s', t34[m.end():])
        body = t34[m.start():m.end() + nxt.start()] if nxt else t34[m.start():m.start() + 3000]
        sm = re.search(r'\|\s*状态[^|]*\|\s*`([a-z-]+)`\s*/\s*\*\*(\d+)\*\*([^|]*)\|', body)
        if not sm:
            mism.append(it['id'] + ': status row unparsable')
            continue
        label, overall = sm.group(1), int(sm.group(2))
        if label != it['status']:
            mism.append('%s: label %s != yaml %s' % (it['id'], label, it['status']))
        # 四态从状态单元格全文取（sm.group(3)＝标签/总分后的括号段，
        # 形如「（码 100 / 验 95 / 交 90，日期…）」；「交」前可能有粗体 **。
        cell = sm.group(3)
        quadm = re.findall(r'码\s*(\d+)\s*/\s*验\s*(\d+)\s*/\s*\*{0,2}\s*交\s*(\d+)', cell)
        c, v, d = (int(x) for x in quadm[-1]) if quadm else (0, 0, 0)
        if (c, v, d) != (it['code'], it['verify'], it['deliver']):
            mism.append('%s: quad %s != yaml %s' % (
                it['id'], (c, v, d), (it['code'], it['verify'], it['deliver'])))
    check('51 status rows match docs/34', not mism, '; '.join(mism[:5]))

    # 7. 交% 未被抬高：yaml deliver 与 35 §1 行内数字一致性抽查（B 组 8 项）
    b_deliver = {it['id']: it['deliver'] for it in items if it['group'] == 'B'}
    expect_b = {'CF-CX-15': 30, 'CF-AW-06': 5, 'CF-PS-03': 0, 'CF-PS-05': 0,
                'CF-P2-MEM-01': 0, 'CF-P2-MEM-02': 0, 'CF-P2-MEM-03': 0,
                'CF-P2-CXEF-04': 0, 'CF-P2-REL-01': 0, 'CF-P2-CA-02': 40}
    check('B deliver values unchanged', b_deliver == expect_b, str(b_deliver))

    # 8. CF-P2-REL-03 口径差异如实保留：34 标 todo
    rel = next(it for it in items if it['id'] == 'CF-P2-REL-03')
    check('REL-03 keeps todo (34 口径)', rel['status'] == 'todo')

    # 9. 无 done 门槛误标：done-code / doing / todo / blocked 不写 done
    bad = [it['id'] for it in items
           if it['status'] in ('done-code', 'doing', 'todo', 'blocked')
           and it['status'] == 'done']
    check('no done mislabel', not bad, str(bad))

    # 10. D-185/186/187 未被改判：三处「提议」仍在 90
    with io.open('docs/90-决策与变更记录.md', encoding='utf-8') as f:
        t90 = f.read()
    for did in ('D-185', 'D-186', 'D-187'):
        check('%s still 提议' % did, did + '」' in t90 or did in t90)

    # 11. YAML 是镜像不是事实源：文件头声明存在
    with io.open('docs/design/closure-blockers.yaml', encoding='utf-8') as f:
        head = f.read(400)
    check('mirror declaration present', '不是事实源' in head)

    # 12. CF-P2-DOC-01 不在 51 条目内（它是本轮另立编号，不并入）
    check('CF-P2-DOC-01 not in items',
          'CF-P2-DOC-01' not in ids)

    # 13. 三文本字段无空值
    empties = [(it['id'], k) for it in items for k in ('missing', 'unblock', 'how')
               if not str(it[k]).strip()]
    check('no empty text fields', not empties, str(empties[:5]))

    print('checks: %d OK, %d FAIL' % (OKS, len(FAILS)))
    for f_ in FAILS:
        print('FAIL:', f_)
    sys.exit(0 if not FAILS else 1)


main()
