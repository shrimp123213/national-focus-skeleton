/**
 * Focus card style comparison (design sample, not the live panel).
 * Usage: npx tsx scripts/build-card-sample.ts → docs/國策卡片-樣式比較.html
 * Lays out three trees with the real layoutTree and icons, drawn in three card styles.
 */
import { writeFileSync } from 'node:fs';
import { drawTree, f, samplePage, styles, type Tree } from './sample-kit';

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

const sections = styles
  .map(
    (style, index) =>
      `<section class="style style-${style.key}" data-style="${style.key}" ${index ? 'hidden' : ''}>${trees.map((tree) => drawTree(style, tree)).join('')}</section>`,
  )
  .join('');

const header = `  <h1>国策卡片样式比较（样品，未改正式介面）</h1>
  <p>三种样式使用同一套正式排版（layoutTree，核心分支置中、上层置中于下层）与正式图示，局面相同：已完成、进行中、等待成果、可开始、条件未满、路线已锁定、重要国策 ✦、互斥分歧 ⇋。鼠标悬停卡片可看完整名称与天数。</p>
  <p>C 勋章式：以图示勋章为主角，名称牌置中在下，不用方框包住两者；状态由勋章表现（可开始亮金框、条件未满去色、进行中外圈进度环、已完成实心金、路线锁定红斜纹与删除线），天数是勋章底部的小标签。</p>
  <div class="switch">${styles.map((style, index) => `<button data-show="${style.key}" aria-pressed="${index === 0}">${style.label}</button>`).join('')}</div>`;
const script = `for (const button of document.querySelectorAll('[data-show]')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-show]')) other.setAttribute('aria-pressed', String(other === button));
    for (const section of document.querySelectorAll('[data-style]')) section.hidden = section.dataset.style !== button.dataset.show;
    history.replaceState(null, '', '#' + button.dataset.show);
  });
}
// Open a style directly with #medal, #old or #current.
document.querySelector('[data-show="' + location.hash.slice(1) + '"]')?.click();`;
const html = samplePage('国策卡片样式比较', header, sections, script);

writeFileSync(new URL('../docs/國策卡片-樣式比較.html', import.meta.url), html);
console.log('written docs/國策卡片-樣式比較.html');
