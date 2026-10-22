#!/usr/bin/env node
/* Usage: node scripts\visual-check.cjs --stage p0 --base-url http://127.0.0.1:4173
 * Optional: --routes /shows,/calendar --widths 375,1440 --themes forest,ocean
 * --reduced-motion --skip-auth --auth-only --ocean-candidates --channel msedge
 * Reports include failed layout assertions; a baseline never silently suppresses failures.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFixtures, loadPlaywright } = require('./lib/frontend-fixture.cjs');

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`未知参数：${argv[i]}`);
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
const args = options(process.argv.slice(2));
const stage = String(args.stage || 'current');
assert(/^[a-zA-Z0-9_-]+$/.test(stage), 'stage 只能包含字母、数字、下划线和短横线');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.cache', 'visual', stage);
const baseURL = String(args['base-url'] || 'http://127.0.0.1:5173');
const routes = String(args.routes || '/,/shows,/feeds,/downloads,/organizer,/calendar,/review,/logs,/settings,/shows/1').split(',');
const widths = String(args.widths || '375,768,1280,1440').split(',').map(Number);
const themes = String(args.themes || 'forest,ocean').split(',');
const reducedMotion = args['reduced-motion'] ? 'reduce' : 'no-preference';
const { chromium, devices } = loadPlaywright();
fs.mkdirSync(output, { recursive: true });

async function layout(page, auth) {
  return page.evaluate(auth => {
    const visible = node => { const r = node.getBoundingClientRect(), style = getComputedStyle(node); return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && !node.closest('[aria-hidden="true"], [inert]'); };
    const rect = node => { const r = node.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) }; };
    const panel = document.querySelector('.auth-panel');
    const nodes = [...document.querySelectorAll(auth ? '.auth-panel, .auth-panel input, .auth-panel button' : 'main button, main input, main h1, main h2, .top-navigation, .brand-mark, .top-actions')].filter(visible);
    const overflow = nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(node => ({ tag: node.tagName, label: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 90), className: String(node.className), bounds: rect(node) }));
    const header = document.querySelector('.top-navigation'), brand = document.querySelector('.brand-mark'), actions = document.querySelector('.top-actions');
    const pendingVisibleImages = [...document.images].filter(image => { const r = image.getBoundingClientRect(); return visible(image) && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && (!image.complete || !image.naturalWidth); }).map(image => image.currentSrc || image.src);
    return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, title: document.querySelector('h1,h2')?.textContent.trim(), overflow, panel: panel ? rect(panel) : null, header: header ? rect(header) : null, brand: brand ? rect(brand) : null, actions: actions ? rect(actions) : null, bodyTextLength: document.body.textContent.trim().length, imageCount: document.images.length, pendingVisibleImages, brokenImages: [...document.images].filter(image => image.complete && !image.naturalWidth).map(image => image.currentSrc) };
  }, auth);
}

function assertions(result, auth) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  check(result.bodyTextLength > (auth ? 40 : 100), '应渲染真实非空页面内容');
  check(result.scrollWidth <= result.viewport.width + 1, `页面横向溢出：${result.scrollWidth}px > ${result.viewport.width}px`);
  check(result.overflow.length === 0, '可见内容或控件超出横向视口');
  check(result.brokenImages.length === 0, '存在未能加载的图片');
  check(result.pendingVisibleImages.length === 0, '首屏图片尚未加载完成');
  if (auth) {
    check(Boolean(result.panel), '登录/初始化面板必须存在');
    if (result.panel) {
      check(result.panel.x >= -1 && result.panel.right <= result.viewport.width + 1, '认证卡片超出横向视口');
      check(result.panel.y >= -1 && result.panel.bottom <= result.viewport.height + 1, '认证卡片超出纵向视口');
    }
  } else {
    check(Boolean(result.header), '应用顶栏必须存在');
    if (result.header) check(Math.abs(result.header.height - 78) < 1, '顶栏保持 78px 高度契约');
    if (result.brand && result.actions) check(result.brand.right <= result.actions.x + 1, '品牌与顶栏工具重叠');
  }
  return failures;
}

async function ready(page, route, auth) {
  if (auth) await page.locator('.auth-panel').waitFor();
  else {
    await page.locator('.top-navigation').waitFor();
    // Route fallbacks reuse real page class names. Wait for the busy region to
    // disappear before selecting business content, rather than timing a skeleton.
    await page.waitForFunction(() => ![...document.querySelectorAll('main [aria-busy="true"], main [role="status"]')].some(node => node.getAttribute('aria-busy') === 'true' || /正在加载|正在读取/.test(node.textContent)));
    const finalRoute = new URL(page.url()).pathname;
    const selectors = { '/': '.dashboard-stat-strip', '/shows': '.show-card-grid', '/calendar': '.calendar-item', '/shows/1': '.detail-title h1', '/feeds': '.feed-card', '/downloads': '[aria-label="下载任务列表"]' };
    if (selectors[finalRoute]) await page.locator(selectors[finalRoute]).first().waitFor();
  }
  // Offscreen lazy artwork must not hold a visual run open. Visible images are
  // decoded before capture so reduced-motion screenshots contain actual art.
  await page.waitForFunction(() => [...document.images].filter(image => {
    const r = image.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && !image.closest('[hidden], [aria-hidden="true"], [inert]');
  }).every(image => image.complete && image.naturalWidth > 0));
  await page.evaluate(async () => { await Promise.all([...document.images].filter(image => { const r = image.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; }).map(image => image.decode().catch(() => {}))); });
  await page.waitForTimeout(reducedMotion === 'reduce' ? 150 : 850);
  await page.evaluate(() => document.fonts.ready);
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: String(args.channel || 'msedge') });
  const report = { stage, baseURL, reducedMotion, fixture: 'deterministic 36 shows, 40 calendar entries, local SVG artwork', screenshots: [], failures: [], environment: { browser: await browser.version(), headless: true }, startedAt: new Date().toISOString() };
  async function capture(theme, width, route, auth) {
    const authMode = auth || 'authenticated';
    const context = await browser.newContext(auth ? { ...devices['iPhone 13'], reducedMotion } : { viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion });
    const fixture = await installFixtures(context, { theme, auth: authMode });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const slug = auth || (route === '/' ? 'home' : route.slice(1).replaceAll('/', '-'));
    const name = `${theme}-${auth ? 'iphone13' : width}-${slug}${reducedMotion === 'reduce' ? '-reduced' : ''}`;
    try {
      await page.goto(new URL(auth ? '/' : route, baseURL).href, { waitUntil: 'domcontentloaded' });
      await ready(page, route, auth);
      const result = await layout(page, auth);
      const failures = assertions(result, auth);
      if (errors.length) failures.push(`页面脚本异常：${errors.join('; ')}`);
      if (fixture.unmocked.length) failures.push(`未覆盖接口：${fixture.unmocked.join(', ')}`);
      await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
      const record = { name, route: auth ? `auth:${auth}` : route, finalRoute: new URL(page.url()).pathname, theme, ...result, failures, errors, requests: fixture.requests };
      report.screenshots.push(record);
      for (const failure of failures) report.failures.push({ name, failure });
      console.log(`${failures.length ? 'FAIL' : 'PASS'} ${name}${failures.length ? ': ' + failures.join('；') : ''}`);
      if (args['ocean-candidates'] && theme === 'ocean' && !auth && ['/shows', '/settings'].includes(route) && [375, 1440].includes(width)) {
        for (const [candidate, ink, ink2, muted] of [['A', '#1d2433', '#424b5c', '#606978'], ['B', '#252b36', '#4b5260', '#646b76']]) {
          const style = await page.addStyleTag({ content: `:root[data-theme="ocean"] { --ink:${ink}; --ink-2:${ink2}; --muted:${muted}; }` });
          await page.screenshot({ path: path.join(output, `${name}-candidate-${candidate}.png`), animations: 'disabled' });
          await style.evaluate(node => node.remove());
        }
      }
    } catch (error) {
      report.failures.push({ name, failure: String(error) });
      await page.screenshot({ path: path.join(output, `${name}-failed.png`), animations: 'disabled' }).catch(() => {});
      console.error(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
  }
  try {
    // Authentication is checked first so layout findings can be repaired while the matrix runs.
    if (!args['skip-auth']) for (const theme of themes) for (const auth of ['login', 'bootstrap']) await capture(theme, 390, '/', auth);
    if (!args['auth-only']) for (const theme of themes) for (const width of widths) for (const route of routes) await capture(theme, width, route);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.passed = report.failures.length === 0;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify({ passed: report.passed, screenshotCount: report.screenshots.length, failureCount: report.failures.length, report: path.join(output, 'report.json') }));
  process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
