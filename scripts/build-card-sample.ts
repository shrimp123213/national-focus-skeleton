/**
 * Focus card style comparison (design sample, not the live panel).
 * Usage: npx tsx scripts/build-card-sample.ts → docs/國策卡片-樣式比較.html
 * Lays out three trees with the real layoutTree and icons, drawn in three card styles.
 */
import { writeFileSync } from 'node:fs';
import { layoutTree } from '../src/layout';
import { icon } from '../src/icons';

type State = 'completed' | 'active' | 'waiting' | 'available' | 'locked' | 'sealed';
type Focus = {
  id: string;
  name: string;
  branch: string;
  icon: string;
  days: number;
  prerequisites: string[][];
  state: State;
  progress?: number;
  pivotal?: boolean;
  head?: boolean;
};
type Tree = { title: string; core: string; focuses: Focus[]; mutex: [string, string][] };

const f = (
  id: string,
  name: string,
  branch: string,
  iconName: string,
  days: number,
  prerequisites: string[][],
  state: State,
  extra: Partial<Focus> = {},
): Focus => ({ id, name, branch, icon: iconName, days, prerequisites, state, ...extra });

const trees: Tree[] = [
  {
    title: '帝国枢密政令（核心＋两侧翼，推进中局面）',
    core: '帝国枢密政令',
    mutex: [['b3', 'b4']],
    focuses: [
      f('w1', '铁炉堡冬粮调配', '西境铁壁整饬', 'army', 21, [], 'completed'),
      f('w2', '驰原巡骑编制改革', '西境铁壁整饬', 'army', 21, [['w1']], 'available'),
      f('w3', '外围警戒堡垒加固', '西境铁壁整饬', 'industry', 28, [['w2']], 'locked'),
      f('w4', '铁甲师团联合操演', '西境铁壁整饬', 'army', 28, [['w3']], 'locked', { pivotal: true }),
      f('b1', '帝国影子审计令', '帝国枢密政令', 'crown', 14, [], 'completed'),
      f('b2', '实物资产封存细则', '帝国枢密政令', 'industry', 14, [['b1']], 'completed'),
      f('b3', '查扣特区货栈', '帝国枢密政令', 'industry', 14, [['b2']], 'active', {
        progress: 43,
        head: true,
      }),
      f('b4', '颁布惩罚性特别关税', '帝国枢密政令', 'trade', 14, [['b2']], 'sealed', { head: true }),
      f('b5', '重组维里迪斯转运链', '帝国枢密政令', 'trade', 21, [['b3']], 'locked'),
      f('b6', '清查特区代偿路由', '帝国枢密政令', 'science', 21, [['b4']], 'sealed'),
      f('b7', '行会实物专营配额', '帝国枢密政令', 'trade', 21, [['b5']], 'locked'),
      f('b8', '帝冕硬通货法统', '帝国枢密政令', 'crown', 21, [['b6']], 'sealed'),
      f('b9', '建立帝国平准储备', '帝国枢密政令', 'industry', 21, [['b7']], 'locked'),
      f('b10', '设立帝国独立清算所', '帝国枢密政令', 'trade', 21, [['b8']], 'sealed'),
      f('b11', '大平原经济统御法典', '帝国枢密政令', 'crown', 21, [['b9', 'b10']], 'locked', {
        pivotal: true,
      }),
      f('e1', '西郊试水池数据复核', '远洋方舟备战', 'science', 14, [], 'waiting', { progress: 100 }),
      f('e2', '防蚀秘银龙骨锻压', '远洋方舟备战', 'industry', 28, [['e1']], 'locked'),
      f('e3', '八舱重水排斥阵列', '远洋方舟备战', 'science', 28, [['e2']], 'locked'),
      f('e4', '远洋方舟起造令', '远洋方舟备战', 'industry', 35, [['e3']], 'locked', { pivotal: true }),
    ],
  },
  {
    title: '王庭与氏族权柄（开局推进中）',
    core: '王庭与氏族权柄',
    mutex: [['a3', 'a4']],
    focuses: [
      f('a1', '王庭集会昭告', '王庭与氏族权柄', 'crown', 14, [], 'active', { progress: 64 }),
      f('a2', '筹备迎冬大狩', '王庭与氏族权柄', 'army', 21, [['a1']], 'locked'),
      f('a3', '王庭编户定居', '王庭与氏族权柄', 'crown', 28, [['a2']], 'locked', { head: true }),
      f('a4', '重敬百族血誓', '王庭与氏族权柄', 'diplomacy', 28, [['a2']], 'locked', { head: true }),
      f('a5', '立置巡天粮台', '王庭与氏族权柄', 'industry', 28, [['a3']], 'locked'),
      f('a6', '放宽荒原猎界', '王庭与氏族权柄', 'army', 28, [['a4']], 'locked'),
      f('a7', '整肃氏族私律', '王庭与氏族权柄', 'crown', 21, [['a5']], 'locked'),
      f('a8', '敕权氏族长老', '王庭与氏族权柄', 'diplomacy', 21, [['a6']], 'locked'),
      f('a9', '建置王庭常备卫队', '王庭与氏族权柄', 'army', 28, [['a7']], 'locked'),
      f('a10', '编组草原子弟战团', '王庭与氏族权柄', 'army', 28, [['a8']], 'locked'),
      f('a11', '落定草原立冬新约', '王庭与氏族权柄', 'crown', 28, [['a9', 'a10']], 'locked', {
        pivotal: true,
      }),
    ],
  },
  {
    title: '神圣教权与异端危机（等待选择路线）',
    core: '神圣教权与异端危机',
    mutex: [['c3', 'c4']],
    focuses: [
      f('c1', '下达第二惩戒谕令', '神圣教权与异端危机', 'crown', 14, [], 'completed'),
      f('c2', '审判庭异端深讯', '神圣教权与异端危机', 'science', 14, [['c1']], 'completed'),
      f('c3', '启动光芒审判所铁律', '神圣教权与异端危机', 'crown', 21, [['c2']], 'available', { head: true }),
      f('c4', '拟定神圣赎罪敕约', '神圣教权与异端危机', 'diplomacy', 21, [['c2']], 'available', {
        head: true,
      }),
      f('c5', '颁布圣域净空敕令', '神圣教权与异端危机', 'army', 21, [['c3']], 'locked'),
      f('c6', '构筑圣域魔导绝缘壁', '神圣教权与异端危机', 'science', 21, [['c4']], 'locked'),
      f('c7', '集结圣裁先锋战团', '神圣教权与异端危机', 'army', 21, [['c5']], 'locked'),
      f('c8', '完成绝密法理交割', '神圣教权与异端危机', 'diplomacy', 21, [['c6']], 'locked'),
      f('c9', '争议云海净火示威', '神圣教权与异端危机', 'army', 14, [['c7']], 'locked'),
      f('c10', '划定云海界碑信标', '神圣教权与异端危机', 'diplomacy', 14, [['c8']], 'locked'),
      f('c11', '定音：圣都新秩序敕书', '神圣教权与异端危机', 'crown', 14, [['c9', 'c10']], 'locked', {
        pivotal: true,
      }),
    ],
  },
];

type Style = {
  key: string;
  label: string;
  w: number;
  h: number;
  gx: number;
  gy: number;
  top: number;
  bottom: number;
};
const styles: Style[] = [
  { key: 'medal', label: 'C 勋章式（提案）', w: 156, h: 104, gx: 184, gy: 136, top: 0, bottom: 104 },
  { key: 'old', label: 'A 旧版横式', w: 188, h: 66, gx: 228, gy: 122, top: 0, bottom: 66 },
  { key: 'current', label: 'B 现行直式', w: 168, h: 94, gx: 200, gy: 142, top: 0, bottom: 94 },
];
const ORIGIN_X = 28;
const ORIGIN_Y = 70;
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const metaText = (focus: Focus) =>
  focus.state === 'completed'
    ? '✓ 已完成'
    : focus.state === 'active'
      ? `${Math.round(((focus.progress ?? 0) * focus.days) / 100)} / ${focus.days} 日`
      : focus.state === 'waiting'
        ? '等待成果'
        : focus.state === 'sealed'
          ? '路线已锁定'
          : `${focus.days} 日`;

function card(style: Style, focus: Focus, x: number, y: number): string {
  const title = `${focus.name}（${metaText(focus)}）`;
  const badges = `${focus.pivotal ? '<span class="pivot" title="重要国策">✦</span>' : ''}${focus.head ? '<span class="flag" title="互斥路线的分歧点">⇋</span>' : ''}`;
  const pos = `left:${x}px;top:${y}px;width:${style.w}px;height:${style.h}px`;
  if (style.key === 'medal') {
    return `<button class="m-node ${focus.state}" style="${pos}" title="${escape(title)}"><span class="m-medal" style="--p:${focus.progress ?? 0}">${icon(focus.icon)}<span class="m-days">${escape(metaText(focus))}</span>${badges}</span><span class="m-plate"><span class="m-name">${escape(focus.name)}</span></span></button>`;
  }
  const progress =
    focus.state === 'active' || focus.state === 'waiting'
      ? `<span class="progress"><i style="width:${focus.progress ?? 0}%"></i></span>`
      : '';
  return `<button class="node ${style.key} ${focus.state}" style="${pos}" title="${escape(title)}"><span class="node-icon">${icon(focus.icon)}</span><span class="node-text"><span class="node-name">${escape(focus.name)}</span><span class="node-meta">${escape(metaText(focus))}</span></span>${badges}${progress}</button>`;
}

function drawTree(style: Style, tree: Tree): string {
  const laid = layoutTree(tree.focuses, tree.core);
  const at = new Map(
    laid.map((n) => [n.id, { x: (n.x * style.gx) / 2 + ORIGIN_X, y: n.y * style.gy + ORIGIN_Y }]),
  );
  const width = Math.max(...[...at.values()].map((p) => p.x)) + style.w + ORIGIN_X;
  const height = Math.max(...[...at.values()].map((p) => p.y)) + style.h + 40;
  const lines: string[] = [];
  for (const node of tree.focuses) {
    const to = at.get(node.id)!;
    for (const parent of node.prerequisites.flat()) {
      const from = at.get(parent)!;
      const x1 = from.x + style.w / 2;
      const y1 = from.y + style.bottom;
      const x2 = to.x + style.w / 2;
      const y2 = to.y + style.top;
      const middle = y1 + Math.max(14, (y2 - y1) / 2);
      const radius = Math.min(10, Math.abs(x2 - x1) / 2, Math.abs(y2 - middle));
      const direction = x2 > x1 ? 1 : -1;
      const d =
        x1 === x2
          ? `M${x1} ${y1}V${y2}`
          : `M${x1} ${y1}V${middle - radius}Q${x1} ${middle} ${x1 + direction * radius} ${middle}H${x2 - direction * radius}Q${x2} ${middle} ${x2} ${middle + radius}V${y2}`;
      const done = tree.focuses.find((n) => n.id === parent)!.state === 'completed';
      const alternative = node.prerequisites.some((g) => g.length > 1 && g.includes(parent));
      lines.push(
        `<path class="connector ${done ? 'done' : ''} ${alternative ? 'alternative' : ''}" d="${d}"/>`,
      );
    }
  }
  for (const [a, b] of tree.mutex) {
    const pa = at.get(a)!;
    const pb = at.get(b)!;
    const y = style.key === 'medal' ? pa.y + 28 : pa.y + style.h / 2;
    const xa = style.key === 'medal' ? pa.x + style.w / 2 + 34 : pa.x + style.w;
    const xb = style.key === 'medal' ? pb.x + style.w / 2 - 34 : pb.x;
    lines.push(`<path class="connector mutex" d="M${xa} ${y}H${xb}"/>`);
  }
  const banners = [...new Set(tree.focuses.map((n) => n.branch))].map((branch) => {
    const xs = tree.focuses.filter((n) => n.branch === branch).map((n) => at.get(n.id)!.x);
    const left = Math.min(...xs) - 8;
    const right = Math.max(...xs) + style.w + 8;
    return `<div class="banner ${branch === tree.core ? 'core' : ''}" style="left:${left}px;width:${right - left}px">${escape(branch)}</div>`;
  });
  const cards = tree.focuses.map((n) => card(style, n, at.get(n.id)!.x, at.get(n.id)!.y));
  return `<figure class="tree"><figcaption>${escape(tree.title)}</figcaption><div class="canvas" style="width:${width}px;height:${height}px">${banners.join('')}<svg class="lines" width="${width}" height="${height}">${lines.join('')}</svg>${cards.join('')}</div></figure>`;
}

const sections = styles
  .map(
    (style, index) =>
      `<section class="style style-${style.key}" data-style="${style.key}" ${index ? 'hidden' : ''}>${trees.map((tree) => drawTree(style, tree)).join('')}</section>`,
  )
  .join('');

const html = `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>国策卡片样式比较</title>
<style>
:root {
  --ink: #0d1310; --bg: #131a16; --panel: #19221d; --gold: #dcc27c; --gold-deep: #a88d4c;
  --text: #ece6d4; --muted: #a8b0a1; --faint: #7d867a; --green: #72c492; --amber: #e6a950;
  --red: #d9705f; --line-strong: rgba(217, 191, 120, 0.32);
  --sans: 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', system-ui, sans-serif;
  --serif: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', Georgia, var(--sans);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ink); color: var(--text); font-family: var(--sans); font-size: 14px; }
header { position: sticky; top: 0; z-index: 5; padding: 14px 24px; background: rgba(13, 19, 16, 0.94); border-bottom: 1px solid var(--line-strong); backdrop-filter: blur(6px); }
header h1 { margin: 0 0 6px; font: 600 18px var(--serif); color: var(--gold); letter-spacing: 0.08em; }
header p { margin: 4px 0; color: var(--muted); font-size: 12.5px; max-width: 980px; line-height: 1.6; }
.switch { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.switch button { font: inherit; color: var(--text); background: #1d2621; border: 1px solid var(--line-strong); border-radius: 7px; padding: 6px 14px; cursor: pointer; }
.switch button[aria-pressed='true'] { border-color: var(--gold); color: #fffaf0; background: #2b3528; }
main { padding: 8px 24px 60px; }
.tree { margin: 22px 0 8px; }
.tree figcaption { color: var(--muted); font-size: 12.5px; margin-bottom: 4px; }
.canvas { position: relative; background:
  radial-gradient(circle at 50% 0%, rgba(220, 194, 124, 0.05), transparent 60%),
  linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px) 0 0 / 28px 28px,
  linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px) 0 0 / 28px 28px, var(--bg);
  border: 1px solid rgba(217, 191, 120, 0.12); border-radius: 12px; overflow: hidden; }
.lines { position: absolute; inset: 0; pointer-events: none; }
.connector { fill: none; stroke: rgba(220, 194, 124, 0.3); stroke-width: 2.4; }
.connector.done { stroke: var(--gold); stroke-width: 3; }
.connector.alternative { stroke-dasharray: 8 6; }
.connector.mutex { stroke: var(--red); stroke-width: 2; stroke-dasharray: 2 6; stroke-linecap: round; }
.banner { position: absolute; top: 16px; height: 34px; display: flex; align-items: center; justify-content: center;
  border-bottom: 1px solid var(--line-strong); background: linear-gradient(180deg, transparent, rgba(220, 194, 124, 0.05));
  font: 600 13.5px var(--serif); letter-spacing: 0.18em; color: #e5d3a0; }
.banner.core { color: var(--gold); border-bottom-color: var(--gold-deep); }
button { font: inherit; color: inherit; }

/* A/B: the panel's card (A = old horizontal, B = current vertical). */
.node { position: absolute; border-radius: 10px; border: 1px solid rgba(236, 230, 212, 0.34);
  background: linear-gradient(180deg, #25302a, #1b231f); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4); cursor: pointer; }
.node-icon { display: grid; place-items: center; color: var(--gold); background: rgba(220, 194, 124, 0.1);
  border: 1px solid rgba(220, 194, 124, 0.2); }
.node-text { display: grid; gap: 1px; min-width: 0; }
.node-name { font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.node-meta { color: var(--muted); white-space: nowrap; }
.node.old { display: grid; grid-template-columns: 44px 1fr; gap: 10px; align-items: center; padding: 8px 12px 8px 10px; text-align: left; }
.node.old .node-icon { width: 44px; height: 44px; border-radius: 9px; }
.node.old .node-icon svg { width: 26px; height: 26px; }
.node.old .node-name { font-size: 14px; line-height: 1.3; }
.node.old .node-meta { font-size: 11.5px; }
.node.current { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 6px 8px 7px; text-align: center; }
.node.current .node-icon { width: 28px; height: 28px; border-radius: 7px; }
.node.current .node-icon svg { width: 18px; height: 18px; }
.node.current .node-text { justify-items: center; width: 100%; }
.node.current .node-name { font-size: 13px; line-height: 1.25; }
.node.current .node-meta { font-size: 11px; }
.node .pivot { position: absolute; top: 3px; right: 22px; font-size: 12px; color: var(--gold); }
.node.current .pivot { right: auto; left: 8px; }
.node .flag { position: absolute; top: 4px; right: 7px; font-size: 12px; color: var(--red); }
.node .progress { position: absolute; left: 10px; right: 10px; bottom: 5px; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
.node .progress i { display: block; height: 100%; background: var(--green); }
.node.waiting .progress i { background: var(--amber); }
.node.available .node-name { color: #fffaf0; }
.node.locked { opacity: 0.58; border-style: dashed; border-color: rgba(236, 230, 212, 0.26); box-shadow: none; }
.node.locked .node-icon { color: var(--faint); background: rgba(255, 255, 255, 0.03); border-color: rgba(255, 255, 255, 0.08); }
.node.completed { background: linear-gradient(160deg, #8a7438, #57491f); border-color: #eed48d; }
.node.completed .node-icon { background: rgba(255, 240, 200, 0.18); border-color: rgba(255, 240, 200, 0.35); color: #fff3c9; }
.node.completed .node-name { color: #fff7dc; }
.node.completed .node-meta { color: #f1dfa6; }
.node.active { border: 1.5px solid var(--green); box-shadow: 0 0 0 3px rgba(114, 196, 146, 0.16), 0 0 26px rgba(114, 196, 146, 0.24); }
.node.active .node-icon { color: var(--green); background: rgba(114, 196, 146, 0.12); border-color: rgba(114, 196, 146, 0.35); }
.node.active .node-meta { color: #a7e3bd; }
.node.waiting { border: 1.5px solid var(--amber); }
.node.waiting .node-icon, .node.waiting .node-meta { color: var(--amber); }
.node.sealed { opacity: 0.7; border-color: rgba(217, 112, 95, 0.6);
  background: repeating-linear-gradient(-45deg, rgba(217, 112, 95, 0.1) 0 6px, transparent 6px 12px), linear-gradient(180deg, #2a2522, #1f1c1a); }
.node.sealed .node-icon { color: var(--red); background: rgba(217, 112, 95, 0.08); border-color: rgba(217, 112, 95, 0.25); }
.node.sealed .node-meta { color: #f0a898; }

/* C: medal — the icon medal is the focus, the name plate sits under it, no box around both. */
.m-node { position: absolute; display: flex; flex-direction: column; align-items: center; padding: 0; border: 0; background: none; cursor: pointer; }
.m-medal { position: relative; flex: none; width: 58px; height: 58px; border-radius: 50%; display: grid; place-items: center;
  color: var(--gold); background: radial-gradient(circle at 36% 30%, #3a4a3f, #18201b 72%);
  border: 2px solid rgba(220, 194, 124, 0.85);
  box-shadow: 0 0 0 4px var(--bg), 0 0 0 5px rgba(220, 194, 124, 0.28), 0 8px 18px rgba(0, 0, 0, 0.55);
  transition: transform 0.15s, box-shadow 0.15s; }
.m-medal svg { width: 30px; height: 30px; }
.m-node:hover .m-medal { transform: translateY(-2px); box-shadow: 0 0 0 4px var(--bg), 0 0 0 5px var(--gold), 0 0 22px rgba(220, 194, 124, 0.35); }
.m-days { position: absolute; bottom: -9px; left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: 10.5px; line-height: 16px;
  padding: 0 7px; border-radius: 9px; color: var(--muted); background: #0f1512; border: 1px solid rgba(220, 194, 124, 0.35); }
.m-plate { margin-top: 15px; width: 100%; padding: 5px 8px 6px; text-align: center;
  background: linear-gradient(180deg, rgba(38, 48, 42, 0.96), rgba(24, 31, 27, 0.96));
  border: 1px solid rgba(220, 194, 124, 0.2); border-top: 2px solid rgba(220, 194, 124, 0.6); border-radius: 3px 3px 9px 9px; }
.m-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 13px; font-weight: 600; line-height: 1.28; color: var(--text); }
.m-node .pivot { position: absolute; top: -7px; right: -9px; font-size: 13px; color: var(--gold); text-shadow: 0 0 6px rgba(220, 194, 124, 0.7); }
.m-node .flag { position: absolute; top: -6px; left: -11px; font-size: 12px; color: var(--red); }
.m-node.available .m-medal { box-shadow: 0 0 0 4px var(--bg), 0 0 0 5px rgba(220, 194, 124, 0.55), 0 0 20px rgba(220, 194, 124, 0.28); }
.m-node.available .m-name { color: #fffaf0; }
.m-node.locked .m-medal { color: var(--faint); background: radial-gradient(circle at 36% 30%, #263029, #141a16 72%);
  border-color: rgba(168, 176, 161, 0.35); box-shadow: 0 0 0 4px var(--bg), 0 0 0 5px rgba(168, 176, 161, 0.12); }
.m-node.locked .m-plate { border-top-color: rgba(168, 176, 161, 0.3); background: rgba(22, 29, 25, 0.92); }
.m-node.locked .m-name { color: #9aa394; }
.m-node.completed .m-medal { color: #2c240f; background: radial-gradient(circle at 36% 30%, #f3dd99, #a8893f 75%); border-color: #f6e2a6;
  box-shadow: 0 0 0 4px var(--bg), 0 0 0 5px rgba(238, 212, 141, 0.5), 0 0 18px rgba(238, 212, 141, 0.3); }
.m-node.completed .m-days { color: #f1dfa6; border-color: rgba(238, 212, 141, 0.6); }
.m-node.completed .m-plate { border-top-color: #eed48d; background: linear-gradient(180deg, rgba(76, 64, 30, 0.95), rgba(40, 34, 18, 0.95)); }
.m-node.completed .m-name { color: #fff2c8; }
.m-node.active .m-medal { color: var(--green); border-color: rgba(114, 196, 146, 0.5); }
.m-node.active .m-medal::before, .m-node.waiting .m-medal::before { content: ''; position: absolute; inset: -7px; border-radius: 50%;
  background: conic-gradient(var(--ring) calc(var(--p) * 1%), rgba(255, 255, 255, 0.08) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px)); }
.m-node.active { --ring: var(--green); }
.m-node.waiting { --ring: var(--amber); }
.m-node.active .m-days { color: #a7e3bd; border-color: rgba(114, 196, 146, 0.55); }
.m-node.active .m-plate { border-top-color: var(--green); }
.m-node.waiting .m-medal { color: var(--amber); border-color: rgba(230, 169, 80, 0.5); }
.m-node.waiting .m-days { color: var(--amber); border-color: rgba(230, 169, 80, 0.55); }
.m-node.waiting .m-plate { border-top-color: var(--amber); }
.m-node.sealed .m-medal { color: rgba(217, 112, 95, 0.8); border-color: rgba(217, 112, 95, 0.5);
  background: repeating-linear-gradient(-45deg, rgba(217, 112, 95, 0.12) 0 5px, transparent 5px 10px), radial-gradient(circle at 36% 30%, #2e2724, #1a1614 72%);
  box-shadow: 0 0 0 4px var(--bg), 0 0 0 5px rgba(217, 112, 95, 0.18); }
.m-node.sealed .m-days { color: #f0a898; border-color: rgba(217, 112, 95, 0.45); }
.m-node.sealed .m-plate { border-top-color: rgba(217, 112, 95, 0.5); background: rgba(30, 25, 23, 0.92); }
.m-node.sealed .m-name { color: #a9928c; text-decoration: line-through; text-decoration-color: rgba(217, 112, 95, 0.55); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 8px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>国策卡片样式比较（样品，未改正式介面）</h1>
  <p>三种样式使用同一套正式排版（layoutTree，核心分支置中、上层置中于下层）与正式图示，局面相同：已完成、进行中、等待成果、可开始、条件未满、路线已锁定、重要国策 ✦、互斥分歧 ⇋。鼠标悬停卡片可看完整名称与天数。</p>
  <p>C 勋章式：以图示勋章为主角，名称牌置中在下，不用方框包住两者；状态由勋章表现（可开始亮金框、条件未满去色、进行中外圈进度环、已完成实心金、路线锁定红斜纹与删除线），天数是勋章底部的小标签。</p>
  <div class="switch">${styles.map((style, index) => `<button data-show="${style.key}" aria-pressed="${index === 0}">${style.label}</button>`).join('')}</div>
</header>
<main>${sections}</main>
<script>
for (const button of document.querySelectorAll('[data-show]')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-show]')) other.setAttribute('aria-pressed', String(other === button));
    for (const section of document.querySelectorAll('[data-style]')) section.hidden = section.dataset.style !== button.dataset.show;
    history.replaceState(null, '', '#' + button.dataset.show);
  });
}
// Open a style directly with #medal, #old or #current.
document.querySelector('[data-show="' + location.hash.slice(1) + '"]')?.click();
</script>
</body>
</html>
`;

writeFileSync(new URL('../docs/國策卡片-樣式比較.html', import.meta.url), html);
console.log('written docs/國策卡片-樣式比較.html');
