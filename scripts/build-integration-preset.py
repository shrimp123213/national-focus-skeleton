# Builds the 世界后台引擎 × 国策档案 integration preset for Workflow Assistant (工作流助手).
# Usage: python scripts/build-integration-preset.py <世界后台引擎 preset.json> <out.json> [world]
#
# The world task keeps its structured JSON output. Since v0.18 it writes plain-text guidance for
# national focus: <国策指引>…</国策指引> inside the "analysis" string, which Workflow Assistant moves
# into <Analysis> and extractInjectTags picks up. The script's own update task turns the guidance
# into a validated proposal. The source may be a plain engine preset or an earlier integration
# preset; earlier integration segments are removed first, so the build can run again.
import copy
import json
import re
import sys
from pathlib import Path

TASK = '世界时局与经济简报'
TAG = '国策指引'
OLD_TAGS = ['国策提案']
API_VERSION = 2
SUFFIX = '（国策整合）'
RULES_NAME = '国策推演规则（国策整合）'
DATA_NAME = '国策档案（国策整合）'


def gate_open(world):
    return f"<%_ if (String(`{{{{replica:val}}}}`).trim() === {json.dumps(world, ensure_ascii=False)}) {{ _%>\n"


GATE_CLOSE = '\n<%_ } _%>'


def gate(world, body):
    """Send a segment only to the replica that owns national focus."""
    return gate_open(world) + body.strip() + GATE_CLOSE


INTEGRATION_RULES = r'''<国策整合规则>
1. 范围：只有<国策档案>的状态为「可用」时才写国策指引；状态是「暂不可提供」或没有<国策档案>时，本次只推演世界，不写<国策指引>。
2. 分工：
   - 你完成推演后，国策档案会以自己的「局势更新」任务读取这份指引，推进各国国策：选策、国策完成、国策事件、事实、稳定度与战争支持度、换期。它会检查前置、互斥、工期与换期规则，不合规则的部分改写成事件或事实，或略过。
   - 所以指引只写方向与依据，用文字写，不写 JSON，不需要符合任何 schema。
   - 世界变量推演各方的反应、经济、社会、传闻与时代演进。世界变量不得把尚未完成的国策写成已完成；国策的进度只由国策档案记录。
   - 国策档案的事件是玩家与正文看到各国新闻的来源。世界推演中与各国有关的重要发展——国策行动的公开结果、他国的反应、冲突、外交与协议——都要写进指引，说法与日期和世界变量的事件脉络一致。
3. 读法：<各国国策>是国策档案整理的各国现况，只列已启用的国家。
   - 每国标题注明 AI 国或玩家国，以及稳定度与战争支持度；其下是本期议程、长期方向、推进中的主国策、已选路线、已完成国策、现行制度、承诺与相关事件。
   - 「国策推演参考」列出主国策的 ID、工期届满的日期与完成还需的成果。AI 国另列「可选国策」与「主国策完成后新开放」的国策，括号内依序是 ID、分支、工期；其余未完成国策只列名称。
4. 指引内容（逐国写；没有变化的国家写「本期无重大变化」）：
   - 局势：本期与该国有关的发展，每件写出故事日期（年月日）与经过；进行中的事件写它推进到哪里。
   - 国策：主国策在本期是否完成、受阻或改变；AI 国空闲时会选哪一项国策（写国策名称与 ID，并说明理由；只从「可选国策」或「主国策完成后新开放」中选）；正文或世界推演是否已实际做成某项尚未完成的国策；本期议程是否已完成，或因局势变化已不适用（需要换期）。
   - 数值：稳定度、战争支持度的变化方向、大约幅度与原因。
   - 玩家国的选策由玩家决定：只写局势与数值，不建议选策。
5. 时间：日期用<国策档案>的<时间>所附的日期格式；不早于该国 cursor 的日期，不晚于 now 的日期。
6. 输出位置：整个回复仍是 WorldPaper_Update_Format 规定的 {"analysis":…,"patch":[…]}。
   - 在 analysis 的 Step10 末尾写一次 <国策指引>…</国策指引>。标签内是纯文字，可以分行、条列；它位于 analysis 字串之中，换行与引号要像 analysis 的其他内容一样转义。引用时用「」，不用英文双引号。
   - 其他地方提到它时只写「国策指引」四字，不加尖括号（系统只取最后一个标签）。
   - 国策指引不写进 patch；patch 只更新世界变量。
</国策整合规则>

<国策指引范例>
<国策指引>
【奥古斯提姆帝国】
- 局势：490年3月2日北境债券暴跌，帝都商会撤资；3月9日诺斯加德递交抗议照会，要求帝国停止清查北境账目。
- 国策：主国策「统一行省税制」于3月12日如期完成；接着选「清丈北境田亩」（tax_survey），因为税制要落实到地方，前置已完成。
- 数值：稳定度小幅下降（约 -3），因北境债券风波；战争支持度不变。
【北境联邦】
- 局势：490年3月9日向帝国递交抗议照会，边境商路暂停。
- 国策：本期无重大变化。
- 数值：战争支持度略升（约 +2），因民间反帝情绪。
</国策指引>
</国策指引范例>'''


def rules_segment(world):
    body = '\n\n'.join([
        f'VOID: 织界者，{world}同时承载「国策档案」：你在推演世界的同时，为各国的长期国策写一份「国策指引」，交给国策档案依规则落实。<国策整合规则>说明指引的分工、读法与写法。',
        INTEGRATION_RULES,
    ])
    return gate(world, body)


DATA = r'''<%_
// 国策档案（国策脚本挂在页面上的 NationalFocusIntegration）为本次请求准备资料并登记。
// 工作流助手只在真正执行任务时渲染提示词，所以每次渲染都是一次正式请求。
const nfReplica = String(`{{replica:val}}`).trim();
let nf = null;
if (nfReplica === __WORLD__) {
  let api = null;
  try {
    api = window.NationalFocusIntegration || (window.parent && window.parent.NationalFocusIntegration) || null;
  } catch (error) {
    api = null;
  }
  if (!api || api.version !== __VERSION__ || typeof api.prepare !== 'function') {
    nf = { status: 'unavailable', reason: 'no_api' };
  } else {
    try {
      const requestId = 'wf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      nf = await api.prepare(lastMessageId, { mode: 'request', requestId });
    } catch (error) {
      nf = { status: 'unavailable', reason: 'prepare_failed' };
    }
  }
}
// 故事日数字 → 日期（与国策档案 storyDay 同一公式）。
const nfDate = (day) => {
  if (typeof day !== 'number' || !Number.isFinite(day)) return '无法换算';
  const date = new Date(Math.round((day - 719528) * 86400000));
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};
_%>
<%_ if (nf && nf.status === 'ready') { _%>
VOID: 以下是国策档案为本次推演提供的资料（状态：可用）。依<国策整合规则>写国策指引。

<国策档案>
<时间>
now：<%= nf.now %>（<%= nfDate(nf.now) %>）
各国 cursor：
<%_ for (const [id, cursor] of Object.entries(nf.cursors || {})) { _%>
- <%= id %>：<%= cursor %>（<%= nfDate(cursor) %>）
<%_ } _%>
</时间>
<各国国策>
<%- nf.summary %>
</各国国策>
</国策档案>
<%_ } else if (nf) { _%>
VOID: <国策档案 状态="暂不可提供" 原因="<%= nf.reason %>"/>
本期没有可用的国策资料：本次只推演世界，不写<国策指引>。
<%_ } _%>'''


COT_FOCUS = '''- Step4.1A：国策推演（依<国策整合规则>；<国策档案>不是「可用」时写「本期无国策档案」，跳过本步与 Step10）
  - 时间窗：now 是哪一天？逐国列出 cursor，以及是 AI 国还是玩家国；本次推进各国 cursor → now
  - 逐国：主国策在区间内是否完成或受阻？空闲的 AI 国会从「可选国策」（主国策完成后也可从「主国策完成后新开放」）选哪一项？正文或世界推演是否已实际做成某项尚未完成的国策？本期议程是否已完成或已不适用？
  - 交给世界推演：各国的选择与成果会引起哪些他国、团体、经济或社会的反应？逐条列出，在 Step4.2 与 Step5 推演、写进世界变量；与各国有关的重要发展，到 Step10 写进国策指引
'''

COT_TAIL = '''Step10：国策指引（<国策档案>不是「可用」时写「本期无国策档案」，不输出标签）
- 一致性：对照 Step4.2–Step7 的世界推演，指引中的事件、日期与国策方向不得与世界变量矛盾；同一件事两边都提时，指引写国家做了什么，世界写各方怎么反应
- 覆盖：逐条对照 Step5.1 推进或新建的世界事件，凡与已启用国家有关的重要发展都写进指引，每件附故事日期
- 选策：AI 国建议的国策都出自「可选国策」或「主国策完成后新开放」；玩家国不建议选策
- 最后写出国策指引（纯文字，逐国分段，不写 JSON）：
<国策指引>
【国家名】
- 局势：……
- 国策：……
- 数值：……
</国策指引>
'''

TAIL = '<国策档案>为「可用」时，在 analysis 的 Step10 末尾写出 <国策指引>…</国策指引>：标签内是逐国的纯文字指引，不写 JSON。'


def find(groups, name):
    for index, group in enumerate(groups):
        if group.get('name') == name:
            return index
    raise SystemExit(f'预设缺少提示词段「{name}」；本脚本依世界后台引擎 v6.5 的段落结构修改')


def insert_before(text, marker, addition, label):
    if marker not in text:
        raise SystemExit(f'「{label}」找不到插入位置：{marker!r}')
    return text.replace(marker, addition + marker, 1)


def strip_integration(task, world):
    """Remove the segments an earlier build added, so the result equals a plain engine preset."""
    task['promptGroups'] = [g for g in task['promptGroups'] if g.get('name') not in (RULES_NAME, DATA_NAME)]
    block = re.escape(gate_open(world)) + r'.*?' + re.escape(GATE_CLOSE)
    cot = task['promptGroups'][find(task['promptGroups'], 'COT')]
    cot['content'] = re.sub(block + r'\n', '', cot['content'], flags=re.S)
    tail = task['promptGroups'][find(task['promptGroups'], 'deepseek尾部')]
    tail['content'] = re.sub(r'\n' + block + r'$', '', tail['content'], flags=re.S)
    task['extractInjectTags'] = [t for t in task.get('extractInjectTags') or [] if t not in [TAG, *OLD_TAGS]]


def build(preset, world):
    out = copy.deepcopy(preset)
    name = preset.get('name', '世界后台引擎')
    out['name'] = name if name.endswith(SUFFIX) else name + SUFFIX
    tasks = [t for t in out['tasks'] if t.get('name') == TASK]
    if len(tasks) != 1:
        raise SystemExit(f'预设中「{TASK}」任务应恰好一个，实际 {len(tasks)} 个')
    target = tasks[0]
    if target.get('structuredOutputMode') != 'addon_json_patch':
        raise SystemExit('世界任务应为 addon_json_patch 结构化输出；整合依赖 analysis 进入 <Analysis> 后抽取标签')
    strip_integration(target, world)
    target['extractInjectTags'].append(TAG)

    groups = target['promptGroups']
    rules = {'enabled': True, 'name': RULES_NAME, 'role': 'user', 'content': rules_segment(world)}
    # Before the rules acknowledgement: snapshots may move the patch-format segment to the very end.
    groups.insert(find(groups, '变量规则结束'), rules)

    cot = groups[find(groups, 'COT')]
    cot['content'] = insert_before(cot['content'], '- Step4.2：综合推演', gate(world, COT_FOCUS) + '\n', 'COT')
    cot['content'] = insert_before(cot['content'], '```\n</analysis_format>', gate(world, COT_TAIL) + '\n', 'COT')

    data = (DATA.replace('__WORLD__', json.dumps(world, ensure_ascii=False))
            .replace('__VERSION__', str(API_VERSION)))
    groups.insert(find(groups, '背景信息') + 1, {'enabled': True, 'name': DATA_NAME, 'role': 'user', 'content': data})

    tail = groups[find(groups, 'deepseek尾部')]
    tail['content'] = tail['content'].rstrip() + '\n' + gate(world, TAIL)
    return out


def main(source, target, world='阿斯塔利亚'):
    preset = json.loads(Path(source).read_text(encoding='utf-8'))
    out = build(preset, world)
    Path(target).write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    groups = [t for t in out['tasks'] if t['name'] == TASK][0]['promptGroups']
    print('written', target, out['name'], [g['name'] for g in groups])


if __name__ == '__main__':
    main(*sys.argv[1:4])
