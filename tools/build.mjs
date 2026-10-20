// Build step: generates sw.js with a content-hashed precache manifest and a file list for the
// offline-package downloader. Usage: node tools/build.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;
const include = ['index.html', 'manifest.webmanifest', 'css', 'js', 'vendor', 'icons', 'docs'];
const files = [];
const walk = (p) => { const s = statSync(p); if (s.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f)); else files.push(relative(root, p)); };
for (const i of include) { try { walk(join(root, i)); } catch { /* optional */ } }
const list = files.filter(f => !f.endsWith('.map') && !f.includes('/.') && !f.endsWith('.md') || f.startsWith('docs/')).sort();
const hash = createHash('sha256'); for (const f of list) hash.update(f).update(readFileSync(join(root, f)));
const version = hash.digest('hex').slice(0, 12);
const tpl = readFileSync(join(root, 'tools/sw.template.js'), 'utf8');
writeFileSync(join(root, 'sw.js'), tpl.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(['./', ...list.map(f => './' + f)], null, 0)));
writeFileSync(join(root, 'files.json'), JSON.stringify({ version, files: list }, null, 0));
console.log(`sw.js built: ${list.length} files, version ${version}`);
