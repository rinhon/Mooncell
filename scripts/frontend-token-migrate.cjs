/* One-shot, allowlisted P7 codemod. Dry run by default; pass --write to apply.
 * node scripts\frontend-token-migrate.cjs --write
 * Only variables explicitly mapped by @theme inline may become color utilities.
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'frontend', 'src', 'index.css'), 'utf8');
const tokens = new Set([...css.matchAll(/--color-([\w-]+): var\(--[\w-]+\);/g)].map(match => match[1]));
const radii = new Set([...css.matchAll(/--radius-([\w-]+):/g)].map(match => match[1]));
const changes = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.tsx?$/.test(entry.name)) {
      const before = fs.readFileSync(file, 'utf8');
      const after = before
        .replace(/rounded-\[var\(--radius-([\w-]+)\)\]/g, (all, token) => radii.has(token) ? `rounded-${token}` : all)
        .replace(/(text|bg|border|ring|outline|fill|stroke|decoration|from|via|to|placeholder)-\[var\(--([\w-]+)\)\]/g,
          (all, utility, token) => tokens.has(token) ? `${utility}-${token}` : all);
      if (before !== after) {
        changes.push(path.relative(root, file));
        if (process.argv.includes('--write')) fs.writeFileSync(file, after);
      }
    }
  }
}
walk(path.join(root, 'frontend', 'src'));
console.log(JSON.stringify({ write: process.argv.includes('--write'), files: changes }, null, 2));
