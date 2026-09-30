import { imperialDemo } from './demo-content';
import { layoutTree } from './layout';
import type { FocusNode } from './model';

export function demoTree(id = 'augustium', name = '奥古斯提姆帝国') {
  const content = id === 'augustium' ? imperialDemo() : regionalDemo(id);
  return {
    id,
    name,
    description:
      id === 'augustium'
        ? '双头狮鹫之下，八条议程通往共同的明日。'
        : '地方联盟如何把共同承诺变成可运作的制度？',
    stability: 72,
    warSupport: 48,
    evidence: 'UI 示范数值',
    ...content,
    capabilities: [{ id: 'old_roads', name: '既有地方道路', active: true, reason: '示范初始能力' }],
    historical: (id === 'augustium'
      ? ['focus_0_0', 'focus_1_0', 'focus_2_0', 'focus_3_0', 'focus_4_0']
      : ['regional_0', 'regional_8', 'regional_16']
    ).map((node) => ({
      node,
      evidence: '示范历史，不重复领取效果',
    })),
  };
}
function regionalDemo(id: string) {
  const north = id === 'north';
  const names = north
    ? [
        '冬议会开幕',
        '共同的巡林地图',
        '山谷自治约章',
        '联邦巡防署',
        '可供共同求援的哨站',
        '驯鹿道上的信使',
        '跨谷征调限额',
        '北境守望公约',
        '清点冬季储备',
        '开放雪季集市',
        '部族共有粮库',
        '长期粮商合同',
        '共同核验的储粮',
        '保护冰河渡口',
        '为远村预留车队',
        '越冬运输同盟',
        '收集地方口述史',
        '巡回学舍启程',
        '由部族保存典籍',
        '建立联邦档案所',
        '互相承认的纪录',
        '培训山地医者',
        '跨谷疫病通报',
        '留下北境的记忆',
      ]
    : [
        '港口议事会',
        '共同丈量航道',
        '港市自治条例',
        '同盟海务署',
        '互认的航港文书',
        '危机中的联合表决',
        '公开港税分配',
        '群港共同宪约',
        '核对灯塔状态',
        '招集港口船匠',
        '商会护航特许',
        '同盟直属护航队',
        '统一海上求援讯号',
        '暴风季节的备港',
        '联合船坞修缮',
        '不熄的海上灯火',
        '记录商船欠款',
        '共同验货程序',
        '由商会裁决争端',
        '设立港际商事庭',
        '跨港裁决互认',
        '船员的归航保障',
        '救助受灾港市',
        '海路上的信用共同体',
      ];
  const branchNames = north ? ['联邦与部族', '越冬经济', '北境传承'] : ['群港政治', '航路安全', '商事与信用'];
  const nodes: FocusNode[] = names.map((name, i) => {
    const local = i % 8;
    const b = Math.floor(i / 8);
    const parent = (n: number) => `regional_${b * 8 + n}`;
    return {
      id: `regional_${i}`,
      name,
      branch: branchNames[b],
      description: `${north ? '各山谷代表' : '各港代表'}就「${name}」提出共同程序，保留地方执行窗口，并要求按季回报履约结果。这项安排需要${local === 2 ? '承认地方既有权利' : local === 3 ? '把部分地方权限交给共同机构' : '相邻成员共同承担维护及争议处理'}。`,
      reason: '离线地域联盟示范，展示不同国家的议程与互斥制度；非世界书既有设定。',
      icon: b === 0 ? 'crown' : b === 1 ? 'trade' : 'diplomacy',
      x: 0,
      y: 0,
      days: 35,
      durationReason: '地方协商、试行与核查的示范工期。',
      prerequisites:
        local === 0 ? [] : [local === 4 ? [parent(2), parent(3)] : [parent(local === 3 ? 1 : local - 1)]],
      requirements: [],
      sustain: [],
      outcomes: [],
      investments: [`${name}的协商、纪录与执行人力`],
      effects: [{ id: 'institution', kind: 'capability', key: `cap_regional_${i}`, name, active: true }],
      mutex: [2, 3].includes(local)
        ? {
            group: `policy_${b}`,
            route: local === 2 ? 'local' : 'joint',
            lock: 'complete',
            reason: '地方委托与共同机构采取不同权责安排',
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
    analysis: '小型地域联盟示范，以地方委托或共同机构形成不同合作方式。',
    branches: [],
  };
}
