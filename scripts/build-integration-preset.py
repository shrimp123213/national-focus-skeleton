# Builds the 世界后台引擎 × 国策档案 integration preset for Workflow Assistant (工作流助手).
# Usage: python scripts/build-integration-preset.py <exported 世界后台引擎 preset.json> <out.json> [world]
#
# The world task keeps its structured JSON output. The proposal travels like <世界状态摘要>: the model
# writes <国策提案>…</国策提案> inside the "analysis" string, Workflow Assistant moves analysis into
# <Analysis>, and extractInjectTags picks the tag up. National-focus rules come from src/prompts.ts and
# build-weaver-preset.py, so the integration states the same law as the script's own update task.
import copy
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASK = '世界时局与经济简报'
TAG = '国策提案'
API_VERSION = 1


def load_weaver():
    spec = importlib.util.spec_from_file_location('weaver', ROOT / 'scripts' / 'build-weaver-preset.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def builtin_law():
    """DEFAULT_GUIDE and the update task, as the script sends them when the player has not edited them."""
    source = (ROOT / 'src' / 'prompts.ts').read_text(encoding='utf-8')
    guide = re.search(r'export const DEFAULT_GUIDE = `(.*?)`;', source, re.S)
    update = re.search(r'\n  update: `(.*?)`,\n  reshape:', source, re.S)
    if not guide or not update:
        raise SystemExit('src/prompts.ts 中找不到 DEFAULT_GUIDE 或局势更新任务指示')
    for text in (guide.group(1), update.group(1)):
        if '${' in text or '`' in text:
            raise SystemExit('规则文字含模板插值或反引号，需要更新本脚本的读取方式')
    return guide.group(1).strip(), update.group(1).strip()


def gate(world, body):
    """Send a segment only to the replica that owns national focus."""
    return (f"<%_ if (String(`{{{{replica:val}}}}`).trim() === {json.dumps(world, ensure_ascii=False)}) {{ _%>\n"
            f"{body.strip()}\n<%_ }} _%>")


INTEGRATION_RULES = r'''<国策整合规则>
1. 范围：只有<国策档案>的状态为「可用」时才推演国策；状态是「暂不可提供」或没有<国策档案>时，本次只推演世界，不推演国策，也不输出<国策提案>。
2. 分工：
   - 国策提案决定各国国策的进度：选策、国策完成，以及国策造成的直接成果（facts、能力、承诺、稳定度与战争支持度）。世界变量不得把尚未完成的国策写成已完成。
   - 世界变量推演各方的反应、经济、社会、传闻与时代演进。
   - 国策提案的 events 是国策档案的事件纪录与报纸来源，玩家与正文只从这里看到各国新闻。世界推演中与各国有关的重要发展——国策行动的公开结果、他国的反应、冲突、外交与协议——都要在国策提案中写成事件（origin=background，evidence 注明「世界局势」），说法与世界变量的事件脉络一致；已有对应的进行中事件就用 eventUpdates 推进。
   - 同一件事两边都写不算重复；重复结算指同一个效果套用两次。事件的 changes 只写这件事对该国稳定度、战争支持度、能力或承诺的实际影响，不要为了凑数加效果。
   - 已完成且公众可知的国策（例如公开颁布的法令、公开的军事部署）写进 publications。
3. 时间：
   - now 与各国 cursor 是故事日数字（整数为日，小数为一日中的时刻），<国策档案>的<时间>附有对应日期。
   - proposal.until 逐字照抄 now，包括全部小数位；steps.at 用故事日数字，由小到大，不早于该国 cursor、不晚于 now。
   - 国策事件的时间要与世界事件脉络的日期对得上。
4. 依据：<国策律>说的「context」「正文」指<故事信息>，「state」指<国策档案>的<state>。引用本次世界推演或<上期世界状态>时，evidence 注明「世界局势」。<history>只含国策档案实际保存的纪录（complete=false），缺漏的部分不要自行补写成历史。
5. 输出位置：<国策律>与<国策输出格式>所说的「只输出一个 JSON 物件」，在这里指<国策提案>标签里的内容。整个回复仍是 WorldPaper_Update_Format 规定的 {"analysis":…,"patch":[…]}：
   - 在 analysis 的 Step10 末尾写：<国策提案>{"nonce":"<国策档案>的 nonce","proposal":{局势更新根物件}}</国策提案>
   - 标签里写单行压缩 JSON；它位于 analysis 字串之中，双引号要像 analysis 的其他内容一样写成 \"
   - 整个 analysis 只在 Step10 末尾写一次完整的国策提案标签；其他地方提到它时只写「国策提案」四字，不加尖括号（系统只取最后一个标签）
   - 国策提案不写进 patch；patch 只更新世界变量
6. nonce 每次推演都不同，逐字照抄本次<国策档案>的值，不要沿用旧值；proposal.id 也要新取。
</国策整合规则>'''


def rules_segment(world, weaver, guide, task):
    body = '\n\n'.join([
        f'VOID: 织界者，{world}同时承载「国策档案」：各国的长期国策由你在同一次推演中一并推进。以下<国策律>与<国策输出格式>原本写给国策档案的「背景规划者」，指的就是此刻的你；<国策整合规则>说明它们在世界推演中的位置，彼此冲突时以<国策整合规则>为准。',
        INTEGRATION_RULES,
        '<国策律>\n' + guide + '\n\n' + task + '\n</国策律>',
        weaver.FORMAT['update'],
    ])
    return gate(world, body)


DATA = r'''<%_
// 国策档案（国策脚本挂在页面上的 NationalFocusIntegration）为本次请求准备资料并登记 nonce。
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
VOID: 以下是国策档案为本次推演提供的资料（状态：可用）。依<国策整合规则>与<国策律>推进各国国策。

<国策档案 nonce="<%= nf.nonce %>">
<时间>
now：<%= nf.now %>（<%= nfDate(nf.now) %>）
各国 cursor：
<%_ for (const [id, cursor] of Object.entries(nf.cursors || {})) { _%>
- <%= id %>：<%= cursor %>（<%= nfDate(cursor) %>）
<%_ } _%>
</时间>
<state>
<%- JSON.stringify(nf.state) %>
</state>
<history>
<%- JSON.stringify(nf.history) %>
</history>
<schema>
<%- JSON.stringify(nf.schema) %>
</schema>
</国策档案>
<%_ } else if (nf) { _%>
VOID: <国策档案 状态="暂不可提供" 原因="<%= nf.reason %>"/>
本期没有可用的国策资料：本次只推演世界，不推演国策，也不输出<国策提案>。
<%_ } _%>'''


COT_FOCUS = '''- Step4.1A：国策推演（依<国策整合规则>与<国策律>；<国策档案>不是「可用」时写「本期无国策档案」，跳过本步与 Step10）
  - 时间窗：now 是多少？逐国列出 cursor、calibration、control、skipDelegate；本次推进各国 cursor → now
  - 事实：从各国 cursor 到 now，<故事信息>与<上期世界状态>中有哪些与各国有关的事？各在哪个故事日？哪些可写成 facts？哪些等待中国策的 outcomes 已取得？
  - 逐国：主国策是否在区间内完成、完成时点是否晚于前置与成果取得的时点；空闲的 AI 国依当时条件选策，选策前逐项写出核对：prerequisites 的每一组在该时点至少有一项已完成（含本次更早完成的）、没有被互斥路线锁定、requirements 成立，任一项不成立就不能选；玩家国只在跳时且 skipDelegate=true 时代选；正文或事件是否已实际做成某项未完成国策（achieved／bypassed／不完成）；本期主要目的是否已完成或已不适配（换期）
  - 国策事件：先推进 state.events.ongoing；国策的执行若有持续过程，由同一事件承接
  - 交给世界推演：本期各国的选择、完成与直接成果，会引起哪些他国、团体、经济或社会的反应？逐条列出，在 Step4.2 与 Step5 推演、写进世界变量；其中与各国有关的重要发展，到 Step10 再写成国策事件
'''


def cot_tail(weaver):
    update = weaver.COT['update']
    start = update.index('Step 8：格式自检')
    end = update.index('</analysis_format>')
    checks = update[start:end].strip().split('\n', 1)[1]
    return ('Step10：国策提案（<国策档案>不是「可用」时写「本期无国策档案」，不输出标签）\n'
            '- 一致性：对照 Step4.2–Step7 的世界推演，国策提案的事件、事实与选策不得与世界变量矛盾；同一件事两边都提时，国策写国家做了什么，世界写各方怎么反应\n'
            '- 选策复核：每项 selections 的国策，在其 at 时点前置都已完成、未被互斥锁定、条件成立；不成立的删去，改选当时真正可开始的国策\n'
            '- 事件复核：逐条对照 Step5.1 推进或新建的世界事件，凡与已启用国家有关的重要发展，在国策提案中写成事件或 eventUpdates（时间放进对应的时间步骤）；公开的国策完成写进 publications。时间跨度长、局势有重大变化，而 events、eventUpdates、publications 全空时，回头补齐\n'
            '- 格式自检（对照<国策输出格式>；只写发现的问题与修正，没有问题写「通过」）：\n'
            + '\n'.join('  ' + line for line in checks.split('\n')) + '\n'
            '- 最后写出完整提案（单行压缩 JSON；nonce 逐字照抄<国策档案>；双引号写成 \\"）：\n'
            '<国策提案>{"nonce":"…","proposal":{…}}</国策提案>\n')


TAIL = '<国策档案>为「可用」时，在 analysis 的 Step10 末尾写出 <国策提案>…</国策提案>：标签内是单行压缩 JSON，和 analysis 其他内容一样位于 JSON 字串中，双引号写成 \\"。'


def find(groups, name):
    for index, group in enumerate(groups):
        if group.get('name') == name:
            return index
    raise SystemExit(f'预设缺少提示词段「{name}」；本脚本依世界后台引擎 v6.3 的段落结构修改')


def insert_before(text, marker, addition, label):
    if marker not in text:
        raise SystemExit(f'「{label}」找不到插入位置：{marker!r}')
    return text.replace(marker, addition + marker, 1)


def build(preset, world):
    weaver = load_weaver()
    guide, task = builtin_law()
    out = copy.deepcopy(preset)
    out['name'] = f"{preset.get('name', '世界后台引擎')}（国策整合）"
    tasks = [t for t in out['tasks'] if t.get('name') == TASK]
    if len(tasks) != 1:
        raise SystemExit(f'预设中「{TASK}」任务应恰好一个，实际 {len(tasks)} 个')
    target = tasks[0]
    if target.get('structuredOutputMode') != 'addon_json_patch':
        raise SystemExit('世界任务应为 addon_json_patch 结构化输出；整合依赖 analysis 进入 <Analysis> 后抽取标签')
    tags = list(target.get('extractInjectTags') or [])
    if TAG not in tags:
        tags.append(TAG)
    target['extractInjectTags'] = tags

    groups = target['promptGroups']
    rules = {'enabled': True, 'name': '国策推演规则（国策整合）', 'role': 'user',
             'content': rules_segment(world, weaver, guide, task)}
    # Before the rules acknowledgement: snapshots may move the patch-format segment to the very end.
    groups.insert(find(groups, '变量规则结束'), rules)

    cot = groups[find(groups, 'COT')]
    cot['content'] = insert_before(cot['content'], '- Step4.2：综合推演', gate(world, COT_FOCUS) + '\n', 'COT')
    cot['content'] = insert_before(cot['content'], '```\n</analysis_format>', gate(world, cot_tail(weaver)) + '\n', 'COT')

    data = (DATA.replace('__WORLD__', json.dumps(world, ensure_ascii=False))
            .replace('__VERSION__', str(API_VERSION)))
    groups.insert(find(groups, '背景信息') + 1, {'enabled': True, 'name': '国策档案（国策整合）', 'role': 'user', 'content': data})

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
