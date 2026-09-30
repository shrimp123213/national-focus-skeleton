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
    name: '自订',
    url: 'https://example.invalid/v1',
    model: 'manual-model',
    proxy: '',
    apiKey: 'test-secret',
  });

test('新连线温度预设 0.85，旧设定保留明确数值且补齐进阶栏位', () => {
  assert.equal(defaultConfig().apis[0].temperature, 0.85);
  assert.equal(preset().temperature, 0.85);
  const old = ApiSchema.parse({
    name: '旧',
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

test('预设改名同步任务主要／备援及所有聊天引用，保存不需要 MVU', () => {
  const platform = new DemoPlatform();
  platform.read = async () => {
    throw new Error('无 MVU');
  };
  const controller = new FocusController(platform);
  const initial = defaultConfig();
  initial.jobs.generate.api = '目前连线';
  initial.jobs.update.fallback = ['目前连线'];
  initial.apiBindings.other = '目前连线';
  const next = saveApiPreset(initial, '目前连线', preset(), 'test');
  controller.saveSettings(next);
  const reloaded = new FocusController(platform);
  assert.equal(reloaded.config.jobs.generate.api, '自订');
  assert.deepEqual(reloaded.config.jobs.update.fallback, ['自订']);
  assert.equal(reloaded.config.apiBindings.other, '自订');
  assert.equal(reloaded.config.defaultApi, '自订');
  assert.equal(reloaded.config.apis[0].apiKey, 'test-secret');
  assert.equal(initial.apis[0].name, '目前连线');
  controller.dispose();
  reloaded.dispose();
});

test('聊天选择与全域预设分开，删除后清理引用但保留其他聊天选择', () => {
  let config = saveApiPreset(defaultConfig(), null, preset(), 'chat-a');
  assert.equal(currentApiName(config, 'chat-a'), '自订');
  assert.equal(currentApiName(config, 'chat-b'), '目前连线');
  config.defaultApi = '自订';
  config.apiBindings['chat-b'] = '目前连线';
  assert.equal(currentApiName(config, 'chat-b'), '目前连线');
  assert.equal(currentApiName(config, 'chat-c'), '自订');
  config.jobs.generate.api = '自订';
  config.jobs.update.fallback = ['自订'];
  config = deleteApiPreset(config, '自订');
  assert.equal(config.jobs.generate.api, '');
  assert.deepEqual(config.jobs.update.fallback, []);
  assert.equal(currentApiName(config, 'chat-a'), '目前连线');
  assert.equal(config.apiBindings['chat-b'], '目前连线');
  assert.throws(() => deleteApiPreset(config, '目前连线'), /至少保留/);
  assert.throws(() => saveApiPreset(config, null, config.apis[0], 'chat-a'), /不可重复/);
});

test('保存失败不更新记忆体设定，不以成功讯息掩盖储存错误', () => {
  const platform = new DemoPlatform();
  const controller = new FocusController(platform);
  const before = structuredClone(controller.config);
  platform.saveConfig = () => {
    throw new Error('储存空间不足');
  };
  assert.throws(() => controller.saveSettings(saveApiPreset(before, null, preset(), 'demo')), /储存空间不足/);
  assert.deepEqual(controller.config, before);
  controller.dispose();
});

test('DeepSeek 开关保留其他参数，生成请求包含所有进阶设定与认证', () => {
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
  assert.equal(redactApiError(new Error('test-secret test-header-secret'), [api]), '[隐藏凭证] [隐藏凭证]');
});

test('无效 URL／模型／YAML 与无法套用的进阶设定阻止保存', () => {
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

test('流式回应逐段组合；Cloudflare 524 错误页改为可读的说明', async () => {
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
  assert.match(text, /流式传输/);
  assert.doesNotMatch(text, /<html/);
  assert.match(
    explainOpaqueError('<!DOCTYPE html><html><title>Bad gateway</title>Error code 502</html>'),
    /错误码 502/,
  );
});

test('严格 JSON 只在 API 预设设定：开启加入 response_format 与排除参数，关闭只移除 response_format', () => {
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
