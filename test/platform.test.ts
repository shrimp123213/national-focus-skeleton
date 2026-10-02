import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyDay } from '../src/platform';
import { stateTime } from '../src/story-time';

test('当前时间原文保留纪元、星期日、分隔符和零点，旧状态没有原文时才用日期', () => {
  const time = '復興紀元490年-10月-15日-星期日-00:00';
  const day = storyDay('490-10-14 14:25');
  assert.equal(stateTime({ day, time }), time);
  assert.equal(stateTime({ day, time }, false), '復興紀元490年10月15日');
  assert.equal(stateTime({ day, time: '2026/10/02 14:25' }, false), '2026年10月02日');
  assert.equal(stateTime({ day, time: '2026-10-02T14:25' }, false), '2026年10月02日');
  assert.equal(stateTime({ day }, false), '490年10月14日');
  assert.equal(stateTime({ day }), '490年10月14日 14:25');
  assert.equal(stateTime({ day: 100 }), '故事日 100');
});

test('复兴纪元时间保留分钟精度，接受繁简名称且不以现实星期校正日期', () => {
  const expected = storyDay('490-10-15 14:25');
  assert.equal(storyDay('复兴纪元490年-10月-15日-星期三-14:25'), expected);
  assert.equal(storyDay('復興紀元490年-10月-15日-星期日-14:25'), expected);
  const midnight = storyDay('复兴纪元490年-10月-15日-星期三-00:00');
  assert.ok(Math.abs(expected - midnight - 865 / 1440) < 1e-9);
});

test('复兴纪元跨日、跨月与跨年依故事日期推进', () => {
  const cases = [
    ['490年-10月-15日-星期三-23:55', '490年-10月-16日-星期四-00:05', 10 / 1440],
    ['490年-10月-31日-星期一-14:25', '490年-11月-01日-星期二-14:25', 1],
    ['490年-12月-31日-星期一-14:25', '491年-01月-01日-星期二-14:25', 1],
    ['490年-02月-28日-星期一-00:00', '490年-03月-01日-星期二-00:00', 1],
    ['492年-02月-28日-星期一-00:00', '492年-03月-01日-星期三-00:00', 2],
  ] as const;
  for (const [start, end, days] of cases) {
    assert.ok(Math.abs(storyDay(`复兴纪元${end}`) - storyDay(`复兴纪元${start}`) - days) < 1e-9);
  }
});

test('无效纪元日期、时间及不完整文字明确拒绝', () => {
  for (const raw of [
    '复兴纪元490年-02月-29日-星期三-14:25',
    '复兴纪元490年-04月-31日-星期三-14:25',
    '复兴纪元490年-13月-15日-星期三-14:25',
    '复兴纪元490年-10月-00日-星期三-14:25',
    '复兴纪元490年-10月-15日-星期三-24:00',
    '复兴纪元490年-10月-15日-星期三-14:60',
    '复兴纪元490年-10月-15日-星期八-14:25',
    '复兴纪元490年-10月-15日-星期三',
    '隔天早晨',
    '',
    null,
    -1,
    Infinity,
  ]) {
    assert.throws(() => storyDay(raw), /无法辨识故事时间/);
  }
});

test('原有数值日序与日期格式保持相容', () => {
  assert.equal(storyDay(114.5), 114.5);
  assert.equal(storyDay('490年10月15日'), storyDay('490-10-15'));
  assert.equal(storyDay('2026/09/26 14:25'), storyDay('2026-09-26T14:25'));
  assert.equal(storyDay('0000-01-01'), 0);
});

test('故事时间以日期呈现：日期来源还原成年月日，纯日序维持故事日', async () => {
  const { storyTime } = await import('../src/story-time');
  const day = storyDay('复兴纪元490年-10月-15日-星期三-14:25');
  assert.equal(storyTime(day), '490年10月15日');
  assert.equal(storyTime(day, true), '490年10月15日 14:25');
  assert.equal(storyTime(storyDay('复兴纪元490年-10月-15日-星期三-00:00'), true), '490年10月15日');
  assert.equal(storyTime(114.5), '故事日 114');
});
