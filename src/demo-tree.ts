import { imperialDemo } from './demo-content';
import { layoutTree } from './layout';
import type { FocusNode } from './model';

export function demoTree(id = 'augustium', name = '奧古斯提姆帝國') {
  const content = id === 'augustium' ? imperialDemo() : regionalDemo(id);
  return {
    id,
    name,
    description:
      id === 'augustium'
        ? '雙頭獅鷲之下，八條議程通往共同的明日。'
        : '地方聯盟如何把共同承諾變成可運作的制度？',
    stability: 72,
    warSupport: 48,
    evidence: 'UI 示範數值',
    ...content,
    capabilities: [{ id: 'old_roads', name: '既有地方道路', active: true, reason: '示範初始能力' }],
    historical: (id === 'augustium'
      ? ['focus_0_0', 'focus_1_0', 'focus_2_0', 'focus_3_0', 'focus_4_0']
      : ['regional_0', 'regional_8', 'regional_16']
    ).map((node) => ({
      node,
      evidence: '示範歷史，不重複領取效果',
    })),
  };
}
function regionalDemo(id: string) {
  const north = id === 'north';
  const names = north
    ? [
        '冬議會開幕',
        '共同的巡林地圖',
        '山谷自治約章',
        '聯邦巡防署',
        '可供共同求援的哨站',
        '馴鹿道上的信使',
        '跨谷徵調限額',
        '北境守望公約',
        '清點冬季儲備',
        '開放雪季集市',
        '部族共有糧庫',
        '長期糧商合同',
        '共同核驗的儲糧',
        '保護冰河渡口',
        '為遠村預留車隊',
        '越冬運輸同盟',
        '收集地方口述史',
        '巡迴學舍啟程',
        '由部族保存典籍',
        '建立聯邦檔案所',
        '互相承認的紀錄',
        '培訓山地醫者',
        '跨谷疫病通報',
        '留下北境的記憶',
      ]
    : [
        '港口議事會',
        '共同丈量航道',
        '港市自治條例',
        '同盟海務署',
        '互認的航港文書',
        '危機中的聯合表決',
        '公開港稅分配',
        '群港共同憲約',
        '核對燈塔狀態',
        '招集港口船匠',
        '商會護航特許',
        '同盟直屬護航隊',
        '統一海上求援訊號',
        '暴風季節的備港',
        '聯合船塢修繕',
        '不熄的海上燈火',
        '記錄商船欠款',
        '共同驗貨程序',
        '由商會裁決爭端',
        '設立港際商事庭',
        '跨港裁決互認',
        '船員的歸航保障',
        '救助受災港市',
        '海路上的信用共同體',
      ];
  const branchNames = north ? ['聯邦與部族', '越冬經濟', '北境傳承'] : ['群港政治', '航路安全', '商事與信用'];
  const nodes: FocusNode[] = names.map((name, i) => {
    const local = i % 8;
    const b = Math.floor(i / 8);
    const parent = (n: number) => `regional_${b * 8 + n}`;
    return {
      id: `regional_${i}`,
      name,
      branch: branchNames[b],
      description: `${north ? '各山谷代表' : '各港代表'}就「${name}」提出共同程序，保留地方執行窗口，並要求按季回報履約結果。這項安排需要${local === 2 ? '承認地方既有權利' : local === 3 ? '把部分地方權限交給共同機構' : '相鄰成員共同承擔維護及爭議處理'}。`,
      reason: '離線地域聯盟示範，展示不同國家的議程與互斥制度；非世界書既有設定。',
      icon: b === 0 ? 'crown' : b === 1 ? 'trade' : 'diplomacy',
      x: 0,
      y: 0,
      days: 35,
      durationReason: '地方協商、試行與核查的示範工期。',
      prerequisites:
        local === 0 ? [] : [local === 4 ? [parent(2), parent(3)] : [parent(local === 3 ? 1 : local - 1)]],
      requirements: [],
      sustain: [],
      outcomes: [],
      investments: [`${name}的協商、紀錄與執行人力`],
      effects: [{ id: 'institution', kind: 'capability', key: `cap_regional_${i}`, name, active: true }],
      mutex: [2, 3].includes(local)
        ? {
            group: `policy_${b}`,
            route: local === 2 ? 'local' : 'joint',
            lock: 'complete',
            reason: '地方委託與共同機構採取不同權責安排',
          }
        : null,
      impact: 'normal' as const,
      news: null,
    };
  });
  nodes[15].prerequisites.push(['regional_7']);
  nodes[23].prerequisites.push(['regional_14']);
  return {
    nodes: layoutTree(nodes),
    analysis: '小型地域聯盟示範，以地方委託或共同機構形成不同合作方式。',
    branches: [],
  };
}
