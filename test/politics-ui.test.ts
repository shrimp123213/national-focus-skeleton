import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, installCountry } from '../src/engine';
import { demoTree } from '../src/demo-tree';
import type { Country, Effect, Politics } from '../src/model';
import { periodNote } from '../src/period-ui';
import type { JobStatus } from '../src/platform';
import {
  arcPath,
  factionEffectSkipped,
  factionMembers,
  factionOrder,
  pendingBar,
  pieSlices,
  polar,
  politicsDrawer,
  politicsGauge,
  routeBackers,
} from '../src/politics-ui';

const politics = (): Politics => ({
  ruling: 'cabinet',
  factions: [
    { id: 'crown', name: '皇权派', appeal: '王权', stance: 'hardline', support: 30, color: 0 },
    { id: 'nobles', name: '旧贵族', appeal: '封地', stance: 'hardline', support: 30, color: 1 },
    { id: 'trade', name: '商贸派', appeal: '商路', stance: 'moderate', support: 0, color: 2 },
    { id: 'cabinet', name: '内阁派', appeal: '议会', stance: 'moderate', support: 15, color: 3 },
    { id: 'guild', name: '行会', appeal: '工坊', stance: 'moderate', support: 25, color: 4 },
  ],
  members: [
    { id: 'a', name: '甲家族', kind: 'family', weight: 'light', faction: 'crown', note: '轻' },
    { id: 'b', name: '乙家族', kind: 'family', weight: 'heavy', faction: 'crown', note: '重' },
    { id: 'c', name: '丙学塔', kind: 'institution', weight: 'medium', faction: null, note: '未表态' },
    { id: 'd', name: '丁家族', kind: 'family', weight: 'medium', faction: 'crown', note: '中' },
  ],
  succession: '议会推举',
});
const country = (value: Politics = politics()): Country => {
  const state = installCountry(createState(0), { ...demoTree(), politics: value }, 0);
  return state.countries.augustium;
};
const job = (id: string, state: JobStatus['state']): JobStatus => ({
  id: 'job',
  kind: 'generate',
  state,
  message: '',
  time: '',
  periodWork: {
    transition: { country: id, cause: 'government', ruling: 'crown', reason: '政变', invalidateActive: true },
    approved: true,
  },
});

test('派系排序：执政派系第一，其余依支持度由高到低，同分保留原顺序', () => {
  assert.deepEqual(
    factionOrder(politics()).map((faction) => faction.id),
    ['cabinet', 'crown', 'nobles', 'guild', 'trade'],
  );
});

test('圆饼与细条：依派系排序累计百分比，支持度 0 的派系没有片', () => {
  const slices = pieSlices(politics());
  assert.deepEqual(
    slices.map(({ faction, from, to }) => [faction.id, from, to]),
    [
      ['cabinet', 0, 15],
      ['crown', 15, 45],
      ['nobles', 45, 75],
      ['guild', 75, 100],
    ],
  );
  // The ruling faction at 0 has no slice either.
  const zero = politics();
  zero.factions = zero.factions.map((faction) =>
    faction.id === 'cabinet'
      ? { ...faction, support: 0 }
      : faction.id === 'trade'
        ? { ...faction, support: 15 }
        : faction,
  );
  assert.deepEqual(
    pieSlices(zero).map((slice) => slice.faction.id),
    ['crown', 'nobles', 'guild', 'trade'],
  );
});

test('圆弧座标：0% 在正上方、顺时针；超过半圈才用大弧', () => {
  const [x0, y0] = polar(10, 0);
  const [x1, y1] = polar(10, 25);
  assert.ok(Math.abs(x0) < 1e-9 && Math.abs(y0 + 10) < 1e-9);
  assert.ok(Math.abs(x1 - 10) < 1e-9 && Math.abs(y1) < 1e-9);
  assert.equal(arcPath(10, 0, 25), 'M0.00 -10.00A10 10 0 0 1 10.00 0.00');
  assert.equal(arcPath(10, 0, 75), 'M0.00 -10.00A10 10 0 1 1 -10.00 0.00');
  assert.equal(arcPath(10, 25, 75), 'M10.00 0.00A10 10 0 0 1 -10.00 0.00');
});

test('路线倚重：照写入顺序，忽略已解散的派系；没有政局时为空', () => {
  assert.deepEqual(
    routeBackers(politics(), ['nobles', 'gone', 'crown']).map((faction) => faction.id),
    ['nobles', 'crown'],
  );
  assert.deepEqual(routeBackers(undefined, ['crown']), []);
  assert.deepEqual(routeBackers(politics(), undefined), []);
});

test('成员依分量排列：重、中、轻；null 列出未表态成员', () => {
  assert.deepEqual(
    factionMembers(politics(), 'crown').map((member) => member.id),
    ['b', 'd', 'a'],
  );
  assert.deepEqual(
    factionMembers(politics(), null).map((member) => member.id),
    ['c'],
  );
});

test('已完成国策中没有套用的派系效果标为未套用；略过的国策与非派系效果不受影响', () => {
  const support: Effect = { id: 'up', kind: 'support', faction: 'crown', value: 5 };
  const stability: Effect = { id: 'calm', kind: 'stability', value: 5 };
  const progress = {
    status: 'completed' as const,
    days: 10,
    started: 0,
    completed: 10,
    evidence: '',
    investments: [],
    applied: [],
    public: true,
  };
  assert.equal(factionEffectSkipped(support, progress), true);
  assert.equal(factionEffectSkipped(support, { ...progress, applied: ['up'] }), false);
  assert.equal(factionEffectSkipped(stability, progress), false);
  assert.equal(factionEffectSkipped(support, { ...progress, status: 'active', completed: null }), false);
  const by = { event: 'e', title: '事件', mode: 'bypassed' as const, reason: '他方完成' };
  assert.equal(factionEffectSkipped(support, { ...progress, by }), false);
});

test('待决条：平时显示提示与两个按钮；校准中停用换期并写明原因；换期工作进行中只显示状态', () => {
  const pending = politics();
  pending.pending = { ruling: 'crown', reason: '女皇复辟', at: 0 };
  const normal = country(pending);
  assert.equal(pendingBar(country(), []), '');
  const plain = pendingBar(normal, []);
  assert.match(plain, /政权易手/);
  assert.match(plain, /换期会生成新一期国策树，进行中的国策不承接/);
  assert.match(plain, /data-action="pending-approve" title=/);
  assert.match(plain, /data-action="pending-dismiss"/);
  const calibrating = pendingBar({ ...normal, calibration: true }, []);
  assert.match(calibrating, /pending-hint blocked">先执行「更新局势」完成校准，才能换期/);
  assert.match(calibrating, /data-action="pending-approve" disabled/);
  assert.match(calibrating, /data-action="pending-dismiss"/);
  for (const state of ['queued', 'running'] as const) {
    const busy = pendingBar(normal, [job('augustium', state)]);
    assert.match(busy, /新一期生成中/);
    assert.doesNotMatch(busy, /data-action="pending-/);
  }
  // Another country's job, or a finished one, leaves the buttons.
  assert.match(pendingBar(normal, [job('north', 'running'), job('augustium', 'failed')]), /pending-approve/);
});

test('执政仪表：有政局时显示执政派系；没有政局时是补上政局的按钮，该国的补上工作排队或进行中时停用并显示生成中', () => {
  const ruled = politicsGauge(country(), true, []);
  assert.match(ruled, /data-action="politics" aria-expanded="true"/);
  assert.match(ruled, /内阁派/);
  const plain = installCountry(createState(0), demoTree(), 0).countries.augustium;
  const adding = (id: string, state: JobStatus['state']): JobStatus => ({
    id: 'job',
    kind: 'generate',
    state,
    message: '',
    time: '',
    addPolitics: true,
    candidate: { id, name: '示范', description: '', evidence: '' },
  });
  const idle = politicsGauge(plain, false, []);
  assert.match(idle, /<button class="gauge pol-gauge empty" data-action="politics-add" title=/);
  assert.match(idle, /尚无政局/);
  assert.doesNotMatch(idle, /disabled|spinner/);
  for (const state of ['queued', 'running'] as const) {
    const busy = politicsGauge(plain, false, [adding('augustium', state)]);
    assert.match(busy, /data-action="politics-add" disabled aria-busy="true"/);
    assert.match(busy, /<i class="spinner"><\/i>生成中/);
  }
  // Another country's job, a finished job or a period job of this country leaves the button.
  for (const jobs of [
    [adding('north', 'running')],
    [adding('augustium', 'failed')],
    [job('augustium', 'running')],
  ]) {
    assert.doesNotMatch(politicsGauge(plain, false, jobs), /disabled/);
  }
});

test('政局抽屉的移除政局：可移除时先问再确认；有待决时停用并写出原因', () => {
  const idle = politicsDrawer(country(), false);
  assert.match(idle, /<button class="ghost danger" data-action="politics-remove-ask">移除政局<\/button>/);
  assert.doesNotMatch(idle, /data-action="politics-remove"/);
  const asking = politicsDrawer(country(), true);
  assert.match(asking, /role="alert"/);
  assert.match(asking, /data-action="politics-remove">确认移除<\/button>/);
  assert.match(asking, /data-action="politics-remove-cancel">取消<\/button>/);
  assert.doesNotMatch(asking, /politics-remove-ask/);
  const pending = politics();
  pending.pending = { ruling: 'crown', reason: '女皇复辟', at: 0 };
  // A locked country shows no confirmation, even if one was open.
  for (const html of [politicsDrawer(country(pending), false), politicsDrawer(country(pending), true)]) {
    assert.match(
      html,
      /data-action="politics-remove-ask" disabled title="有待决的执政更替">移除政局<\/button>/,
    );
    assert.match(html, /<small>有待决的执政更替<\/small>/);
    assert.doesNotMatch(html, /data-action="politics-remove"/);
  }
});

test('有待决时，换期生成中的期别说明不重复待决条的「新一期生成中」', () => {
  const pending = politics();
  pending.pending = { ruling: 'crown', reason: '女皇复辟', at: 0 };
  const running = [job('augustium', 'running')];
  assert.equal(periodNote(country(), running), '下一期生成中；事件继续更新，成功后才换树');
  assert.equal(periodNote(country(pending), running), '事件继续更新，成功后才换树');
  assert.equal(periodNote({ ...country(pending), autoPeriod: false }, []), '保留当前国策树；事件仍继续更新');
});
