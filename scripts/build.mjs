// Builds desktop/plugin.js (the single ES module Hermes Desktop loads) by joining src/*.js in file-name order.
//   node scripts/build.mjs           write desktop/plugin.js
//   node scripts/build.mjs --check   fail if desktop/plugin.js is not what the sources produce (CI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const out = path.join(root, 'desktop', 'plugin.js');

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
const built = files.map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (current !== built) {
    console.error('desktop/plugin.js is out of date: run `npm run build` and commit the result.');
    process.exit(1);
  }
  console.log(`desktop/plugin.js is up to date (${files.length} source files)`);
} else {
  fs.writeFileSync(out, built);
  console.log(`built desktop/plugin.js from ${files.length} files (${built.split('\n').length - 1} lines)`);
}
