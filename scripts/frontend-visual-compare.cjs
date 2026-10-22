/* Exact screenshot comparison with ImageMagick; no image rewriting. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const [before, after] = process.argv.slice(2);
if (![before, after].every(stage => /^[\w-]+$/.test(stage || ''))) throw new Error('传入两个视觉阶段名');
const root = path.resolve(__dirname, '..', '.cache', 'visual');
const previous = path.join(root, before), current = path.join(root, after);
const files = fs.readdirSync(previous).filter(file => /-reduced\.png$/.test(file)
  && (!process.argv.includes('--skip-auth') || !file.includes('-iphone13-')));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const results = files.map(file => {
  const a = path.join(previous, file), b = path.join(current, file);
  if (!fs.existsSync(b)) return { file, error: '缺少截图' };
  if (hash(a) === hash(b)) return { file, differentPixels: 0 };
  const result = spawnSync('magick', ['compare', '-metric', 'AE', a, b, 'null:'], { encoding: 'utf8', windowsHide: true });
  const differentPixels = Number(result.stderr.trim().split(/\s/)[0]);
  return result.error || !Number.isFinite(differentPixels)
    ? { file, error: String(result.error || result.stderr) }
    : { file, differentPixels };
});
const report = { before, after, checked: results.length, passed: results.length > 0 && results.every(row => row.differentPixels === 0), results };
fs.writeFileSync(path.join(current, 'comparison.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: results.filter(row => row.differentPixels !== 0) }, null, 2));
if (!report.passed) process.exitCode = 1;
