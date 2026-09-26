/**
 * Builds the Claude Desktop bundle: build/mcpb/ → nulabg-mcp-<version>.mcpb
 *
 * - syncs the manifest version with package.json
 * - lists the default tools and prompts in the manifest (shown in Claude's extension page)
 * - installs production dependencies only
 *
 * Run `npm run build` first.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'build', 'mcpb');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (!existsSync(path.join(root, 'dist', 'cli.js'))) {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ['dist', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
  if (existsSync(path.join(root, f))) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
}

// Tool and prompt lists from the default configuration.
const { loadConfig } = await import(path.join(root, 'dist', 'config.js'));
const { selectTools } = await import(path.join(root, 'dist', 'tools', 'index.js'));
const tools = selectTools(loadConfig({ NULA_API_KEY: 'x', NULA_READ_ONLY: 'false' })).map((t) => ({
  name: t.name,
  description: t.title,
}));

const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
manifest.tools = tools;
manifest.prompts = [
  {
    name: 'issue-invoice',
    description: 'Издай фактура стъпка по стъпка',
    arguments: ['customer', 'description'],
    text: '',
  },
  {
    name: 'process-receipts',
    description: 'Обработи документи с OCR',
    arguments: ['folder', 'document_type'],
    text: '',
  },
  { name: 'month-end-review', description: 'Преглед за месечно приключване', arguments: ['month'], text: '' },
  {
    name: 'collect-overdue',
    description: 'Просрочени вземания и чернови на напомняния',
    arguments: ['min_days_overdue'],
    text: '',
  },
];
writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: stage,
  stdio: 'inherit',
});
execFileSync(npx, ['mcpb', 'validate', path.join(stage, 'manifest.json')], { cwd: root, stdio: 'inherit' });

const out = path.join(root, `nulabg-mcp-${pkg.version}.mcpb`);
execFileSync(npx, ['mcpb', 'pack', stage, out], { cwd: root, stdio: 'inherit' });
console.log(`\n✓ ${path.relative(root, out)}`);
