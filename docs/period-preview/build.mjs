import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..');
let dependencyRoot=join(root,'node_modules');
try {
  await access(join(dependencyRoot,'esbuild/lib/main.js'));
} catch {
  dependencyRoot=resolve(root,'../national-focus/node_modules');
}
const {build}=await import(pathToFileURL(join(dependencyRoot,'esbuild/lib/main.js')).href);
const tsModule=await import(pathToFileURL(join(dependencyRoot,'typescript/lib/typescript.js')).href);
const ts=tsModule.default;
const uiFile=join(root,'src/ui.ts');
const original=await readFile(uiFile,'utf8');
let ui=original.replaceAll('\r\n','\n');
function replaceOnce(from,to) {
  if (ui.split(from).length!==2) {
    throw new Error(`UI source changed; inspect prototype insertion: ${from.slice(0,100)}`);
  }
  ui=ui.replace(from,to);
}

// Patch this build's in-memory source only. Production files and distribution remain unchanged.
ui=`import { periodPlatform, periodBar, periodControl, anchorNotice, anchorBadge, historyBody } from '../docs/period-preview/ui-addon';\n${ui}`;
replaceOnce('<section class="stage ${detailsOpen', '${periodBar(controller.platform, country)}<section class="stage ${detailsOpen');
replaceOnce('<strong class="country-name">${escape(c.name)}</strong>', '<strong class="country-name">${escape(c.name)}</strong>${periodControl(controller.platform, c)}');
replaceOnce('<div class="drawer-body">${progress.started', '<div class="drawer-body">${anchorNotice(controller.platform, country, node)}${progress.started');
replaceOnce('${heads.has(node.id) ?', '${anchorBadge(controller.platform, country, node)}${heads.has(node.id) ?');
replaceOnce('<button data-action="demo-outcome">完成聯運勘查</button>', '<button data-action="period-crisis">載入：局勢突變情境</button><button data-action="period-complete">載入：議程完成情境</button>');
replaceOnce('<button data-action="demo-news">發布示範事件</button>', '<button data-action="period-update">推進事件／演示換期</button>');
replaceOnce("case 'update':\n            await controller.run('update');", `case 'update':
            await periodPlatform(controller.platform).updatePeriod();
            branch = '';
            collapsed.clear();
            centeredCountry = '';
            await controller.refresh();`);
replaceOnce("switch (name) {\n          case 'close':", `switch (name) {
          case 'period-history': {
            const country = currentCountry();
            if (country) {
              openModal('period-history', '往期摘要', historyBody(controller.platform, country), '<button data-modal="close">返回</button>');
            }
            break;
          }
          case 'period-crisis':
          case 'period-complete':
            nodeId = '';
            branch = '';
            query = '';
            collapsed.clear();
            centeredCountry = '';
            periodPlatform(controller.platform).choose(name === 'period-crisis' ? 'crisis' : 'complete');
            await controller.refresh();
            break;
          case 'period-update':
            branch = '';
            collapsed.clear();
            centeredCountry = '';
            await periodPlatform(controller.platform).updatePeriod();
            await controller.refresh();
            break;
          case 'close':`);
replaceOnce("root.addEventListener('change', (event) => {\n    const input = event.target as HTMLInputElement;", `root.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.periodAuto) {
      periodPlatform(controller.platform).setAuto(input.dataset.periodAuto, input.checked);
      return;
    }`);

const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts'],strict:true,noEmit:true,esModuleInterop:true,skipLibCheck:true,resolveJsonModule:true,typeRoots:[join(dependencyRoot,'@types')],types:['node'],baseUrl:root,paths:{zod:[join(dependencyRoot,'zod')],yaml:[join(dependencyRoot,'yaml')],'@noble/hashes/*':[join(dependencyRoot,'@noble/hashes/*')]}};
const host=ts.createCompilerHost(options);
const getSourceFile=host.getSourceFile.bind(host);
host.getSourceFile=(name,languageVersion,onError,shouldCreate)=>resolve(name).toLowerCase()===uiFile.toLowerCase()?ts.createSourceFile(name,ui,languageVersion,true):getSourceFile(name,languageVersion,onError,shouldCreate);
const program=ts.createProgram([join(here,'entry.ts'),join(root,'src/assets.d.ts')],options,host);
const diagnostics=ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:f=>f,getNewLine:()=> '\n'}));
  throw new Error('Prototype TypeScript check failed');
}

const result=await build({
  entryPoints:[join(here,'entry.ts')],bundle:true,format:'iife',target:['es2022'],charset:'utf8',loader:{'.css':'text'},write:false,
  nodePaths:[dependencyRoot],legalComments:'inline',
  plugins:[{name:'existing-ui-period-sample',setup(builder){
    builder.onLoad({filter:/[\\/]src[\\/]ui\.ts$/},()=>({contents:ui,loader:'ts',resolveDir:join(root,'src')}));
    builder.onLoad({filter:/[\\/]src[\\/]style\.css$/},async args=>({contents:(await readFile(args.path,'utf8'))+'\n'+await readFile(join(here,'extra.css'),'utf8'),loader:'text'}));
  }}],
});
const notices=await Promise.all(['zod','yaml','@noble/hashes'].map(async name=>`${name}\n${await readFile(join(dependencyRoot,name,'LICENSE'),'utf8')}`));
const script=result.outputFiles[0].text+`\n/* Third-party notices\n${notices.join('\n\n').replaceAll('*/','* /')}\n*/`;
const output=join(root,'docs/分期國策-現有介面樣品.html');
const html=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>國策檔案 · 現有介面分期樣品</title><style>html,body{margin:0;min-height:100%;background:#141d18;color:#e3ddc9;font:14px system-ui}body>main{padding:8vh 7vw;max-width:680px}h1{font:36px Georgia,serif}p{line-height:1.9;color:#aeb69f}</style></head><body><main><h1>現有腳本 · 分期樣品</h1><p>沿用目前腳本的國家列、路線、畫布、詳情、懸浮球與事件紀錄。新增期別列、換期開關、承接提示及往期摘要。</p><p>從原面板「測試操作」切換兩種情境並推進。資料只在本頁記憶體，不連接 API 或 MVU；重新整理恢復樣品。</p><p id="startup-error" role="alert"></p></main><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`;
await writeFile(output,html,'utf8');
if ((await readFile(uiFile,'utf8'))!==original) {
  throw new Error('Production UI changed during build; inspect concurrent work');
}
await writeFile(join(here,'build-info.json'),JSON.stringify({baseVersion:'0.13.4-skeleton',sourceUiSha256:createHash('sha256').update(original).digest('hex'),sourceStyleSha256:createHash('sha256').update(await readFile(join(root,'src/style.css'))).digest('hex'),typecheck:'passed',output:'../分期國策-現有介面樣品.html'},null,2)+'\n');
console.log(`PASS: patched preview typecheck; built existing UI sample without modifying src or dist: ${output}`);
