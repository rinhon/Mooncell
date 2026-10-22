/* Compare raw gzip bytes and static entry dependencies against the frozen P0 build. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
function inspect(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const entry = /<script[^>]+src="([^"]+)"/.exec(html)[1].replace(/^\//, '');
  const gzip = file => zlib.gzipSync(fs.readFileSync(path.join(dir, file))).length;
  const graph = new Set();
  function visit(file) {
    if (graph.has(file)) return;
    graph.add(file);
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.\/[^"']+\.js)["']/g)) {
      visit(path.posix.join(path.posix.dirname(file), match[1]));
    }
  }
  visit(entry);
  const assets = fs.readdirSync(path.join(dir, 'assets')).filter(file => /\.(js|css)$/.test(file));
  return {
    entry, entryGzipBytes: gzip(entry),
    staticEntryJs: [...graph].map(file => ({ file, gzipBytes: gzip(file) })),
    staticEntryJsGzipBytes: [...graph].reduce((sum, file) => sum + gzip(file), 0),
    allJsCssGzipBytes: assets.reduce((sum, file) => sum + gzip(`assets/${file}`), 0),
    files: assets.map(file => ({ file, gzipBytes: gzip(`assets/${file}`) })),
  };
}
const baseline = inspect(path.join(root, '.cache', 'perf', 'baseline-dist'));
const current = inspect(path.join(root, 'frontend', 'dist'));
const report = { baseline, current, delta: {
  entryGzipBytes: current.entryGzipBytes - baseline.entryGzipBytes,
  staticEntryJsGzipBytes: current.staticEntryJsGzipBytes - baseline.staticEntryJsGzipBytes,
  allJsCssGzipBytes: current.allJsCssGzipBytes - baseline.allJsCssGzipBytes,
}, note: 'gzip按文件分别计算；静态入口依赖不含路由懒加载，不等同于浏览器实际首屏传输量。' };
fs.writeFileSync(path.join(root, '.cache', 'perf', 'final-bundle-comparison.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ baseline: baseline.entryGzipBytes, current: current.entryGzipBytes, delta: report.delta }, null, 2));
