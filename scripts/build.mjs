import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
await mkdir(output, { recursive: true });
const options = {
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  loader: { '.css': 'text' },
  charset: 'utf8',
  minify: false,
  legalComments: 'eof',
};
await build({
  ...options,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(output, 'national-focus.js'),
});
await build({ ...options, entryPoints: [join(root, 'src/preview.ts')], outfile: join(output, 'preview.js') });
const notices = await Promise.all(
  ['zod', 'yaml'].map(
    async (name) => `${name}\n${await readFile(join(root, 'node_modules', name, 'LICENSE'), 'utf8')}`,
  ),
);
const licenseComment = `\n/* Third-party notices\n${notices.join('\n\n').replaceAll('*/', '* /')}\n*/\n`;
const script = (await readFile(join(output, 'national-focus.js'), 'utf8')) + licenseComment;
const preview = (await readFile(join(output, 'preview.js'), 'utf8')) + licenseComment;
await writeFile(join(output, 'national-focus.js'), script, 'utf8');
await writeFile(join(output, 'preview.js'), preview, 'utf8');
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'), 'utf8');
const exported = {
  type: 'script',
  enabled: true,
  name: '【命定之詩】國策檔案 v0.14.8 骨架版',
  id: '3f6c2a9e-5d41-4b8a-9e07-1c2d8b4f6a13',
  content: script,
  info: '正文完成後於背景演化的國策樹。需酒館助手與 MVU。從懸浮球開啟；請先設定可靠故事時間欄位與 API。',
  button: { enabled: true, buttons: [] },
  data: {},
  export_with: { data: false, button: true },
};
await writeFile(join(output, '國策檔案-骨架版-酒館助手.json'), JSON.stringify(exported, null, 2), 'utf8');
const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>國策檔案 · UI 測試</title><style>html,body{margin:0;min-height:100%;background:#141d18;color:#e3ddc9;font:14px system-ui}body>main{padding:10vh 7vw;max-width:600px}h1{font-family:Georgia,serif;font-size:38px;font-weight:400}p{color:#aeb69f;line-height:1.9}</style></head><body><main><small>NATIONAL FOCUS ARCHIVE</small><h1>國策檔案</h1><p>離線 UI 測試頁。右下角的獅鷲懸浮球可以重新開啟面板。所有示範資料只存在本頁記憶體，不會呼叫 AI 或連接酒館。</p><p>你可以拖曳、縮放、點選國策、切換國家，以及用「測試操作」推進進度。重新整理會恢復示範。</p></main><script>${preview.replaceAll('</script', '<\\/script')}</script></body></html>`;
await writeFile(join(output, 'UI測試.html'), html, 'utf8');
await writeFile(join(output, 'index.html'), html, 'utf8');
// News card: the script appends <国策快讯/> to a floor that published news; this display regex
// turns it into a card (Workflow Assistant style), and a prompt regex keeps it out of the prompt.
const card = (await readFile(join(root, 'src/news-card/card.html'), 'utf8')).trim();
// Every AI floor carries the tag since v0.13; only the most recent floors render the newspaper.
const cardDepth = 4;
const regex = (id, scriptName, extra) => ({
  id,
  scriptName,
  findRegex: '/<国策快讯\\s*\\/>/g',
  replaceString: '',
  trimStrings: [],
  placement: [2],
  disabled: false,
  markdownOnly: false,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
  ...extra,
});
await writeFile(
  join(output, '國策快訊-卡片正則.json'),
  JSON.stringify(
    regex('5b0e3f5a-8f2d-4c21-9d0a-6f1c2e7a4b01', '國策快訊卡片', {
      replaceString: `\`\`\`\n${card}\n\`\`\``,
      markdownOnly: true,
      maxDepth: cardDepth,
    }),
    null,
    4,
  ),
  'utf8',
);
// Older floors keep their tag but show nothing, so the tag never appears as plain text.
await writeFile(
  join(output, '國策快訊-舊樓層隱藏正則.json'),
  JSON.stringify(
    regex('5b0e3f5a-8f2d-4c21-9d0a-6f1c2e7a4b03', '國策快訊舊樓層隱藏', {
      markdownOnly: true,
      minDepth: cardDepth + 1,
    }),
    null,
    4,
  ),
  'utf8',
);
await writeFile(
  join(output, '國策快訊-提示移除正則.json'),
  JSON.stringify(
    regex('5b0e3f5a-8f2d-4c21-9d0a-6f1c2e7a4b02', '國策快訊不送給模型', { promptOnly: true }),
    null,
    4,
  ),
  'utf8',
);
// Offline check of the card with a stand-in for the Tavern Helper iframe functions.
const cardPreview = `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>國策快訊卡片預覽</title></head><body style="background:#141d18;padding:24px"><script>window.__emitted=[];window.getCurrentMessageId=()=>7;window.getVariables=(o)=>o&&o.type==='global'?(window.__global||{}):window.__variables;window.insertOrAssignVariables=(v)=>{window.__global=Object.assign(window.__global||{},v);};window.__listeners=new Map();window.eventOn=(event,callback)=>{const group=window.__listeners.get(event)||new Set();group.add(callback);window.__listeners.set(event,group);return {stop:()=>group.delete(callback)};};window.eventEmit=(event,...args)=>{window.__emitted.push([event,...args]);for(const callback of window.__listeners.get(event)||[]){callback(...args);}return Promise.resolve();};</script><iframe id="card" style="width:100%;border:0;height:900px"></iframe><script>const source=${JSON.stringify(card).replaceAll('</script', '<\\/script')};window.showCard=(variables)=>{window.__variables=variables;const frame=document.getElementById('card');frame.srcdoc='<script>for (const k of ["getCurrentMessageId","getVariables","eventEmit","eventOn","insertOrAssignVariables"]) window[k]=parent[k];<\\/script>'+source;};</script></body></html>`;
await writeFile(join(output, '國策快訊-卡片預覽.html'), cardPreview, 'utf8');
console.log(
  'Built: dist/國策檔案-骨架版-酒館助手.json, dist/national-focus.js, dist/UI測試.html, dist/國策快訊-*.json',
);
