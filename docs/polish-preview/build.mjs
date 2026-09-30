import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import vm from 'node:vm';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  noEmit: true,
  esModuleInterop: true,
  skipLibCheck: true,
  types: ['node'],
};
const program = ts.createProgram([join(here, 'entry.ts'), join(here, 'assets.d.ts')], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (file) => file,
      getNewLine: () => '\n',
    }),
  );
  throw new Error('Preview type check failed');
}
const result = await build({
  entryPoints: [join(here, 'entry.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  charset: 'utf8',
  loader: { '.css': 'text', '.html': 'text' },
  write: false,
  legalComments: 'inline',
});
const script = result.outputFiles[0].text;
new vm.Script(script);
const notices = await Promise.all(
  ['zod', 'yaml'].map(
    async (name) => `${name}\n${await readFile(join(root, 'node_modules', name, 'LICENSE'), 'utf8')}`,
  ),
);
const shell = await readFile(join(here, 'shell.html'), 'utf8');
const html = shell.replace(
  '<!-- BUNDLE -->',
  () =>
    `<script>${script.replaceAll('</script', '<\\/script')}</script>\n<!-- ${notices.join('\n\n').replaceAll('--', '—')} -->`,
);
const output = join(root, 'docs/國策檔案-介面打磨樣品.html');
await writeFile(output, html, 'utf8');
console.log(`Built standalone preview: ${output}`);
