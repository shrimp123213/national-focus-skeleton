import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { ApiSchema, ConfigSchema, defaultConfig } from '../src/model';
import {
  applyDeepSeek,
  currentApiName,
  customRequest,
  deepSeekOptions,
  deleteApiPreset,
  redactApiError,
  saveApiPreset,
  setStrictJson,
  validateApi,
} from '../src/api-config';
import { FocusController } from '../src/workflow';
import { DemoPlatform } from '../src/demo';

const preset = () =>
  ApiSchema.parse({
    name: '自訂',
    url: 'https://example.invalid/v1',
    model: 'manual-model',
    proxy: '',
    apiKey: 'test-secret',
  });

test('新連線溫度預設 0.85，舊設定保留明確數值且補齊進階欄位', () => {
  assert.equal(defaultConfig().apis[0].temperature, 0.85);
  assert.equal(preset().temperature, 0.85);
  const old = ApiSchema.parse({
    name: '舊',
    url: '',
    model: '',
    proxy: '',
    temperature: 0.7,
    maxTokens: 16384,
  });
  assert.equal(old.temperature, 0.7);
  assert.equal(old.maxTokens, 16384);
  assert.equal(old.apiKey, '');
  assert.equal(old.customPromptPostProcessing, 'none');
});

test('預設改名同步任務主要／備援及所有聊天引用，保存不需要 MVU', () => {
  const platform = new DemoPlatform();
  platform.read = async () => {
    throw new Error('無 MVU');
  };
  const controller = new FocusController(platform);
  const initial = defaultConfig();
  initial.jobs.generate.api = '目前連線';
  initial.jobs.update.fallback = ['目前連線'];
  initial.apiBindings.other = '目前連線';
  const next = saveApiPreset(initial, '目前連線', preset(), 'test');
  controller.saveSettings(next);
  const reloaded = new FocusController(platform);
  assert.equal(reloaded.config.jobs.generate.api, '自訂');
  assert.deepEqual(reloaded.config.jobs.update.fallback, ['自訂']);
  assert.equal(reloaded.config.apiBindings.other, '自訂');
  assert.equal(reloaded.config.defaultApi, '自訂');
  assert.equal(reloaded.config.apis[0].apiKey, 'test-secret');
  assert.equal(initial.apis[0].name, '目前連線');
  controller.dispose();
  reloaded.dispose();
});

test('聊天選擇與全域預設分開，刪除後清理引用但保留其他聊天選擇', () => {
  let config = saveApiPreset(defaultConfig(), null, preset(), 'chat-a');
  assert.equal(currentApiName(config, 'chat-a'), '自訂');
  assert.equal(currentApiName(config, 'chat-b'), '目前連線');
  config.defaultApi = '自訂';
  config.apiBindings['chat-b'] = '目前連線';
  assert.equal(currentApiName(config, 'chat-b'), '目前連線');
  assert.equal(currentApiName(config, 'chat-c'), '自訂');
  config.jobs.generate.api = '自訂';
  config.jobs.update.fallback = ['自訂'];
  config = deleteApiPreset(config, '自訂');
  assert.equal(config.jobs.generate.api, '');
  assert.deepEqual(config.jobs.update.fallback, []);
  assert.equal(currentApiName(config, 'chat-a'), '目前連線');
  assert.equal(config.apiBindings['chat-b'], '目前連線');
  assert.throws(() => deleteApiPreset(config, '目前連線'), /至少保留/);
  assert.throws(() => saveApiPreset(config, null, config.apis[0], 'chat-a'), /不可重複/);
});

test('保存失敗不更新記憶體設定，不以成功訊息掩蓋儲存錯誤', () => {
  const platform = new DemoPlatform();
  const controller = new FocusController(platform);
  const before = structuredClone(controller.config);
  platform.saveConfig = () => {
    throw new Error('儲存空間不足');
  };
  assert.throws(() => controller.saveSettings(saveApiPreset(before, null, preset(), 'demo')), /儲存空間不足/);
  assert.deepEqual(controller.config, before);
  controller.dispose();
});

test('DeepSeek 開關保留其他參數，生成請求包含所有進階設定與認證', () => {
  const api = preset();
  api.bodyParams = 'seed: 42\n';
  api.requestHeaders = 'X-Custom-Header: test-header-secret';
  api.excludeBodyParams = 'frequency_penalty';
  const strict = applyDeepSeek(api, true, false);
  assert.deepEqual(deepSeekOptions(strict), { strict: true, cot: false });
  assert.equal(parse(strict.bodyParams).seed, 42);
  const cot = applyDeepSeek(strict, false, true);
  assert.deepEqual(deepSeekOptions(cot), { strict: false, cot: true });
  assert.equal(parse(cot.bodyParams).seed, 42);
  assert.equal(cot.includeReasoning, true);
  const body = customRequest(
    strict,
    [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'request' },
    ],
    api.apiKey,
  );
  assert.deepEqual(parse(body.custom_include_body), {
    seed: 42,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  });
  assert.deepEqual(parse(body.custom_exclude_body), ['frequency_penalty', 'top_p', 'reasoning_effort']);
  assert.deepEqual(parse(body.custom_include_headers), {
    'X-Custom-Header': 'test-header-secret',
    Authorization: 'Bearer test-secret',
  });
  assert.equal(body.temperature, 0.85);
  assert.equal(body.max_tokens, 60000);
  assert.equal(body.custom_prompt_post_processing, 'strict');
  assert.ok(!JSON.stringify(body.messages).includes('test-secret'));
  assert.equal(redactApiError(new Error('test-secret test-header-secret'), [api]), '[隱藏憑證] [隱藏憑證]');
});

test('無效 URL／模型／YAML 與無法套用的進階設定阻止保存', () => {
  for (const change of [
    { url: 'invalid' },
    { url: 'javascript:alert(1)' },
    { model: '' },
    { bodyParams: '[1, 2]' },
    { bodyParams: 'field: [' },
    { requestHeaders: 'not an object' },
    { bodyParams: 'seed: 42', url: '' },
    { customPromptPostProcessing: 'strict', proxy: 'proxy' },
  ]) {
    assert.throws(() => validateApi({ ...preset(), ...change }));
  }
  assert.equal(validateApi({ ...preset(), model: 'not-in-list' }).model, 'not-in-list');
  assert.equal(ConfigSchema.parse(defaultConfig()).jobs.generate.api, '');
});

test('流式回應逐段組合；Cloudflare 524 錯誤頁改為可讀的說明', async () => {
  const { readStream } = await import('../src/api-config');
  const { explainOpaqueError } = await import('../src/tavern');
  async function* deltas() {
    yield '{"a"';
    yield ':1}';
  }
  assert.deepEqual(await readStream(deltas()), { content: '{"a":1}' });
  assert.equal(await readStream({ content: 'x' }), null);
  const page =
    'Chat completion request error: <none> <!DOCTYPE html><html><head><title>ggchan.dev | 524: A timeout occurred</title></head><body>Error code 524</body></html>';
  const text = explainOpaqueError(page);
  assert.match(text, /Cloudflare 524/);
  assert.match(text, /流式傳輸/);
  assert.doesNotMatch(text, /<html/);
  assert.match(
    explainOpaqueError('<!DOCTYPE html><html><title>Bad gateway</title>Error code 502</html>'),
    /錯誤碼 502/,
  );
});

test('嚴格 JSON 只在 API 預設設定：開啟加入 response_format 與排除參數，關閉只移除 response_format', () => {
  const api = { ...preset(), bodyParams: 'thinking:\n  type: disabled', excludeBodyParams: 'seed' };
  const on = setStrictJson(api, true);
  assert.deepEqual(parse(on.bodyParams), {
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  });
  assert.equal(on.customPromptPostProcessing, 'strict');
  assert.equal(on.excludeBodyParams, 'seed, top_p, reasoning_effort');
  assert.equal(deepSeekOptions(on).strict, true);
  const off = setStrictJson(on, false);
  assert.deepEqual(parse(off.bodyParams), { thinking: { type: 'disabled' } });
  assert.equal(off.excludeBodyParams, on.excludeBodyParams);
  assert.equal(setStrictJson(preset(), false).bodyParams, '');
});
