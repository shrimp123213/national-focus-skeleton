import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, installCountry } from '../src/engine';
import { demoTree } from '../src/demo-tree';
import { buildNewsBar, foldChinese, insiders, newsFields } from '../src/newsbar';

test('角色卡新闻摊平成「板块/栏位」，也接受旧 MVU 的 [值, 说明]', () => {
  assert.deepEqual(newsFields({ 快讯: { 军事: '甲', 经济: ['乙', '说明'] }, 单栏: '丙' }), {
    '快讯/军事': '甲',
    '快讯/经济': '乙',
    单栏: '丙',
  });
  assert.deepEqual(newsFields(undefined), {});
});

test('玩家所在地用简繁都能对上国名或关键字；玩家选策的国家一律算在内', () => {
  assert.equal(foldChinese('奧古斯提姆帝國・鐵爐堡'), '奥古斯提姆帝国・铁炉堡');
  const state = installCountry(createState(0), { ...demoTree(), keywords: ['鐵爐堡'] }, 0);
  state.countries.augustium.control = 'ai';
  assert.deepEqual(insiders(state, '西大陆-中部-某国'), []);
  assert.deepEqual(insiders(state, '西大陆-中部-铁炉堡'), ['augustium']);
  assert.deepEqual(insiders(state, `西大陆-${foldChinese(state.countries.augustium.name)}`), ['augustium']);
  state.countries.augustium.control = 'player';
  assert.deepEqual(insiders(state, ''), ['augustium']);
});

test('没有上一个 AI 楼层时全部算新闻；之后只有改变的栏位更新时间', () => {
  const state = createState(0);
  const first = buildNewsBar({
    state,
    floor: 1,
    time: 'T1',
    location: '',
    newsPath: '新闻',
    news: { 板: { 甲: '1', 乙: '1' } },
    hasPrevious: false,
  });
  assert.deepEqual(first.changed, ['板/甲', '板/乙']);
  const second = buildNewsBar({
    state,
    floor: 3,
    time: 'T2',
    location: '',
    newsPath: '新闻',
    news: { 板: { 甲: '2', 乙: '1', 丙: '新' } },
    previousNews: { 板: { 甲: '1', 乙: '1' } },
    hasPrevious: true,
    previous: first,
  });
  assert.deepEqual(second.changed, ['板/甲', '板/丙']);
  assert.deepEqual(second.updated, { '板/甲': 'T2', '板/乙': 'T1', '板/丙': 'T2' });
});
