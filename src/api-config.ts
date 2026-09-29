import { parse, stringify } from 'yaml';
import { ApiSchema, type Config } from './model';
import type { GenerateResult, PromptMessage } from './platform';

export type ApiPreset = Config['apis'][number];

function yamlObject(text: string, label: string): Record<string, unknown> {
  if (!text.trim()) {
    return {};
  }
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    throw new Error(`${label}必須是有效的 YAML object`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必須是 YAML object`);
  }
  return value as Record<string, unknown>;
}

export function excludedParams(text: string): string[] {
  if (!text.trim()) {
    return [];
  }
  const value: unknown =
    text.trim().startsWith('[') || text.trim().startsWith('- ')
      ? parse(text)
      : text
          .split(/[,\n]/)
          .map((v) => v.trim())
          .filter(Boolean);
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) {
    throw new Error('排除主體參數須為欄位名稱列表');
  }
  return [...new Set(value.map((v) => v.trim()))];
}

export function validateApi(input: unknown): ApiPreset {
  const api = ApiSchema.parse(input);
  api.name = api.name.trim();
  api.url = api.url.trim();
  api.model = api.model.trim();
  api.proxy = api.proxy.trim();
  if (!api.name) {
    throw new Error('預設名稱不可空白');
  }
  if (api.url) {
    let url: URL;
    try {
      url = new URL(api.url);
    } catch {
      throw new Error('API URL 必須是完整的 http 或 https 網址');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('API URL 必須使用 http 或 https');
    }
    if (!api.model) {
      throw new Error('自訂 API 請填寫模型名稱，或載入模型後選擇');
    }
  }
  yamlObject(api.bodyParams, '附加主體參數');
  yamlObject(api.requestHeaders, '附加請求標頭');
  excludedParams(api.excludeBodyParams);
  if (hasAdvancedApi(api) && (!api.url || api.proxy)) {
    throw new Error('進階參數請使用明確的 API URL 與模型，並清空酒館代理預設名稱');
  }
  return api;
}

export function hasAdvancedApi(api: ApiPreset): boolean {
  return Boolean(
    api.bodyParams.trim() ||
      api.excludeBodyParams.trim() ||
      api.requestHeaders.trim() ||
      api.customPromptPostProcessing !== 'none' ||
      api.includeReasoning ||
      api.reasoningEffort !== 'medium',
  );
}

export function currentApiName(config: Config, chatId: string): string {
  const bound = config.apiBindings[chatId];
  if (config.apis.some((api) => api.name === bound)) {
    return bound;
  }
  return config.apis.find((api) => api.name === config.defaultApi)?.name ?? config.apis[0].name;
}

export function saveApiPreset(
  config: Config,
  original: string | null,
  input: unknown,
  chatId: string,
): Config {
  const api = validateApi(input);
  const next = structuredClone(config);
  if (next.apis.some((item) => item.name === api.name && item.name !== original)) {
    throw new Error('API 名稱不可重複');
  }
  const index = next.apis.findIndex((item) => item.name === original);
  if (original !== null && index < 0) {
    throw new Error('原 API 預設已不存在，請重新開啟設定');
  }
  if (index < 0) {
    next.apis.push(api);
  } else {
    next.apis[index] = api;
    for (const job of Object.values(next.jobs)) {
      if (job.api === original) {
        job.api = api.name;
      }
      job.fallback = job.fallback.map((name) => (name === original ? api.name : name));
    }
    for (const id of Object.keys(next.apiBindings)) {
      if (next.apiBindings[id] === original) {
        next.apiBindings[id] = api.name;
      }
    }
  }
  if (!next.defaultApi || next.defaultApi === original) {
    next.defaultApi = api.name;
  }
  next.apiBindings[chatId] = api.name;
  return next;
}

export function deleteApiPreset(config: Config, name: string): Config {
  if (config.apis.length === 1) {
    throw new Error('至少保留一個 API 預設');
  }
  const next = structuredClone(config);
  next.apis = next.apis.filter((api) => api.name !== name);
  if (next.defaultApi === name) {
    next.defaultApi = next.apis[0].name;
  }
  for (const id of Object.keys(next.apiBindings)) {
    if (next.apiBindings[id] === name) {
      delete next.apiBindings[id];
    }
  }
  for (const job of Object.values(next.jobs)) {
    if (job.api === name) {
      job.api = '';
    }
    job.fallback = job.fallback.filter((item) => item !== name);
  }
  return next;
}

export function deepSeekOptions(api: ApiPreset): { strict: boolean; cot: boolean } {
  const body = yamlObject(api.bodyParams, '附加主體參數');
  return {
    strict: (body.response_format as { type?: string } | undefined)?.type === 'json_object',
    cot: (body.thinking as { type?: string } | undefined)?.type === 'enabled',
  };
}

export function applyDeepSeek(api: ApiPreset, strict: boolean, cot: boolean): ApiPreset {
  const next = structuredClone(api);
  const body = yamlObject(api.bodyParams, '附加主體參數');
  body.thinking = { type: cot ? 'enabled' : 'disabled' };
  if (strict) {
    body.response_format = { type: 'json_object' };
    next.excludeBodyParams = [
      ...new Set([...excludedParams(api.excludeBodyParams), 'top_p', 'reasoning_effort']),
    ].join(', ');
    next.customPromptPostProcessing = 'strict';
  } else {
    delete body.response_format;
  }
  next.bodyParams = stringify(body);
  next.includeReasoning = cot;
  next.reasoningEffort = 'medium';
  return next;
}

export function customRequest(api: ApiPreset, messages: PromptMessage[], secret: string) {
  const headers = yamlObject(api.requestHeaders, '附加請求標頭');
  if (secret && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${secret}`;
  }
  return {
    messages: messages.map(({ role, content }) => ({ role, content })),
    model: api.model.replace(/^models\//, ''),
    max_tokens: api.maxTokens,
    temperature: api.temperature,
    top_p: 0.95,
    stream: api.stream,
    chat_completion_source: 'custom',
    include_reasoning: api.includeReasoning,
    reasoning_effort: api.reasoningEffort,
    enable_web_search: false,
    request_images: false,
    custom_prompt_post_processing: api.customPromptPostProcessing,
    reverse_proxy: api.url,
    proxy_password: '',
    custom_url: api.url,
    custom_include_headers: stringify(headers),
    custom_include_body: api.bodyParams,
    custom_exclude_body: stringify(excludedParams(api.excludeBodyParams)),
  };
}

export function redactApiError(error: unknown, apis: ApiPreset[]): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const api of apis) {
    const secrets = [api.apiKey, api.requestHeaders];
    try {
      secrets.push(...Object.values(yamlObject(api.requestHeaders, '標頭')).map(String));
    } catch {
      // Invalid drafts are reported without echoing their YAML source.
    }
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
      text = text.replaceAll(secret, '[隱藏憑證]');
    }
  }
  return text;
}

/** Workflow Assistant strict JSON tasks: add json_object output only where the preset lacks it. */
export function structuredApi(api: ApiPreset): ApiPreset {
  if (!api.url || api.proxy) {
    // Structured parameters need the Chat Completion path with an explicit endpoint.
    return api;
  }
  const next = structuredClone(api);
  const body = yamlObject(api.bodyParams, '附加主體參數');
  if (!('response_format' in body)) {
    body.response_format = { type: 'json_object' };
    next.bodyParams = stringify(body);
  }
  next.customPromptPostProcessing = 'strict';
  if (!next.excludeBodyParams.trim()) {
    next.excludeBodyParams = 'top_p, reasoning_effort';
  }
  return next;
}

/**
 * The one strict JSON switch (v0.13.3): on adds response_format json_object, strict prompt
 * post-processing and the top_p/reasoning_effort exclusions; off removes only response_format.
 */
export function setStrictJson(api: ApiPreset, strict: boolean): ApiPreset {
  const next = structuredClone(api);
  const body = yamlObject(api.bodyParams, '附加主體參數');
  if (strict) {
    body.response_format = { type: 'json_object' };
    next.excludeBodyParams = [
      ...new Set([...excludedParams(api.excludeBodyParams), 'top_p', 'reasoning_effort']),
    ].join(', ');
    next.customPromptPostProcessing = 'strict';
  } else {
    delete body.response_format;
  }
  next.bodyParams = Object.keys(body).length ? stringify(body) : '';
  return next;
}

type Choice = {
  message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
  text?: unknown;
};
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
/** Accept SillyTavern extracted data, OpenAI choices and plain strings; keep reasoning apart from content. */
/**
 * Read a streamed Chat Completion reply to its end. SillyTavern's ChatCompletionService returns
 * a generator function for `stream: true`; each chunk carries the text so far (and the
 * reasoning in `state.reasoning`). Plain async iterables and chunk deltas are accepted too.
 */
export async function readStream(result: unknown): Promise<GenerateResult | null> {
  const source =
    typeof result === 'function'
      ? (result as () => unknown)()
      : result && typeof result === 'object' && Symbol.asyncIterator in result
        ? result
        : null;
  if (!source || typeof source !== 'object' || !(Symbol.asyncIterator in source)) {
    return null;
  }
  let content = '';
  let reasoning = '';
  for await (const chunk of source as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') {
      content += chunk;
      continue;
    }
    const value = (chunk ?? {}) as { text?: unknown; state?: { reasoning?: unknown } };
    if (typeof value.text === 'string') {
      // SillyTavern yields the whole text so far; a shorter chunk would be a delta.
      content = value.text.startsWith(content) ? value.text : content + value.text;
    }
    if (typeof value.state?.reasoning === 'string' && value.state.reasoning) {
      reasoning = value.state.reasoning;
    }
  }
  content = content.trim();
  return reasoning && reasoning !== content ? { content, reasoning } : { content };
}

export function extractApiResult(result: unknown): GenerateResult {
  if (typeof result === 'string') {
    return { content: result.trim() };
  }
  if (!result || typeof result !== 'object') {
    return { content: '' };
  }
  const value = result as Record<string, unknown> & { choices?: Choice[]; message?: Choice['message'] };
  const first = value.choices?.[0];
  const content =
    text(value.content) ?? text(value.text) ?? text(first?.message?.content) ?? text(first?.text) ?? '';
  const reasoning =
    text(value.reasoning) ??
    text(value.reasoning_content) ??
    text(value.message?.reasoning_content) ??
    text(value.message?.reasoning) ??
    text(first?.message?.reasoning_content) ??
    text(first?.message?.reasoning);
  return reasoning && reasoning !== content ? { content, reasoning } : { content };
}

/** Balanced `{...}` slice starting at `start`, aware of JSON strings. */
function balancedObject(source: string, start: number): string | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return source.slice(start, i + 1);
    }
  }
}
/**
 * Parse a JSON object reply. Like Workflow Assistant, remove code fences and tolerate text or
 * reasoning tags around the object; never repair the object itself.
 */
export function parseJsonReply(output: string): unknown {
  const cleaned = String(output ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const withoutThinking = cleaned.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    // Scan top-level objects only, so a truncated 60k-token reply stays linear to inspect.
    let start = withoutThinking.indexOf('{');
    while (start >= 0) {
      const slice = balancedObject(withoutThinking, start);
      if (!slice) {
        break;
      }
      try {
        return JSON.parse(slice);
      } catch {
        // Prose may contain a braced phrase before the real object.
      }
      start = withoutThinking.indexOf('{', start + slice.length);
    }
    throw error;
  }
}
