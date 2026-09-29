import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyDay } from '../src/platform';

test('復興紀元時間保留分鐘精度，接受繁簡名稱且不以現實星期校正日期', () => {
  const expected = storyDay('490-10-15 14:25');
  assert.equal(storyDay('复兴纪元490年-10月-15日-星期三-14:25'), expected);
  assert.equal(storyDay('復興紀元490年-10月-15日-星期日-14:25'), expected);
  const midnight = storyDay('复兴纪元490年-10月-15日-星期三-00:00');
  assert.ok(Math.abs(expected - midnight - 865 / 1440) < 1e-9);
});

test('復興紀元跨日、跨月與跨年依故事日期推進', () => {
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

test('無效紀元日期、時間及不完整文字明確拒絕', () => {
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
    assert.throws(() => storyDay(raw), /無法辨識故事時間/);
  }
});

test('原有數值日序與日期格式保持相容', () => {
  assert.equal(storyDay(114.5), 114.5);
  assert.equal(storyDay('490年10月15日'), storyDay('490-10-15'));
  assert.equal(storyDay('2026/09/26 14:25'), storyDay('2026-09-26T14:25'));
  assert.equal(storyDay('0000-01-01'), 0);
});
