/* Initial page loading regression. Only deterministic browser fixtures are used.
 * node scripts\frontend-page-loading-check.cjs --base-url http://127.0.0.1:5173
 * Optional: --case settings --channel msedge
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFixtures, loadPlaywright, shows, calendar } = require('./lib/frontend-fixture.cjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const baseUrl = new URL(argument('--base-url', 'http://127.0.0.1:5173')).origin;
const output = path.resolve(__dirname, '..', '.cache', 'frontend-page-loading-check');
const cases = [];
const check = (name, run) => cases.push({ name, run });
const ready = page => page.locator('.page-load-boundary[data-ready="true"]').waitFor();

async function hold(page, matches) {
  let release;
  let blocked = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(url => matches(url), async route => {
    blocked++;
    await gate;
    await route.fallback().catch(() => {});
  });
  return { release, get blocked() { return blocked; } };
}

async function assertWaiting(page) {
  await page.locator('.page-load-boundary[data-ready="false"]').waitFor();
  const content = page.locator('.page-load-content');
  assert.equal(await content.isVisible(), false, '初始依赖未结束前真实页面必须隐藏');
  assert.equal(await content.getAttribute('aria-hidden'), 'true');
  assert(await content.evaluate(node => node.inert), '骨架期间真实内容不得被键盘操作');
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.page-load-boundary').getAttribute('data-ready'), 'false', '等待期间不能短暂显示未完成页面');
}

for (const [name, pathname, endpoint] of [
  ['feeds-shows', '/feeds', '/shows'],
  ['downloads-shows', '/downloads', '/shows'],
  ['calendar-data', '/calendar', '/calendar'],
  ['detail-library', '/shows/1', '/shows/1/library'],
  ['settings-dependent-preview', '/settings', '/setup/path-preview'],
  ['review-data', '/review', '/review'],
  ['logs-data', '/logs', '/logs'],
]) {
  check(name, async ({ page }) => {
    const matches = url => url.pathname === `/api/v1${endpoint}`;
    const gate = await hold(page, matches);
    const requested = page.waitForRequest(request => matches(new URL(request.url())));
    try {
      await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
      await requested;
      await assertWaiting(page);
      assert(gate.blocked > 0, '测试必须实际阻塞指定的数据依赖');
      gate.release();
      await ready(page);
      assert.equal(await page.locator('.page-load-content').isVisible(), true);
      if (name === 'detail-library') assert.equal(await page.locator('.episode-list > li').count(), 3, '详情应连同媒体库数据一起显示');
      return { pathname, endpoint, revealedAfterDependency: true };
    } finally { gate.release(); }
  });
}

check('feeds-nested-clearlogo-appearance', async ({ page }) => {
  await page.route('**/api/v1/shows', route => route.fulfill({ json: shows.map(show => ({ ...show, clearlogo_ready: true })) }));
  await page.route(url => /\/artwork\/clearlogo\/appearance$/.test(url.pathname), route => route.fulfill({ json: { background: 'light' } }));
  const matches = url => url.pathname === '/api/v1/shows/1/artwork/clearlogo/appearance';
  const gate = await hold(page, matches);
  const requested = page.waitForRequest(request => matches(new URL(request.url())));
  try {
    await page.goto(`${baseUrl}/feeds`, { waitUntil: 'domcontentloaded' });
    await requested;
    await assertWaiting(page);
    assert(await page.locator('.page-load-content .clearlogo-plate').count() > 0, '隐藏内容须挂载子组件以启动外观查询');
    gate.release();
    await ready(page);
    assert.equal(await page.locator('.clearlogo-plate').first().getAttribute('data-background'), 'light');
    return { nestedQueryStartedWhileHidden: true, backgroundReadyAtReveal: true };
  } finally { gate.release(); }
});

check('settings-disabled-preview', async ({ page, fixture }) => {
  await page.route('**/api/v1/settings/library', route => route.fulfill({ json: { library_root: '', valid: false, exists: false, writable: false } }));
  await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  assert.equal(fixture.requests.some(request => request.endsWith('/setup/path-preview')), false, '未启用的依赖查询不应启动或阻止显示');
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  return { disabledQueryDoesNotBlock: true };
});

check('calendar-day-cycle-waits-for-images', async ({ page }) => {
  await page.goto(`${baseUrl}/calendar?day=0`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const items = calendar.items.filter(item => item.weekday === 1);
  const paths = new Set(items.map(item => item.cover_url));
  const matches = url => paths.has(url.pathname);
  const gate = await hold(page, matches);
  const requested = page.waitForRequest(request => matches(new URL(request.url())));
  try {
    await page.getByRole('tab', { name: /^周二/ }).click();
    await requested;
    await assertWaiting(page);
    assert(gate.blocked > 0, '切换日期后必须实际等待新面板的图片');
    gate.release();
    await ready(page);
    const panel = page.locator('.page-load-content .calendar-day-panel:not([aria-hidden="true"])');
    await panel.locator('h4').getByText(items[0].title, { exact: true }).waitFor();
    assert.equal(await panel.locator('article.calendar-item').count(), items.length);
    assert.equal(await page.getByRole('tab', { name: /^周二/ }).getAttribute('aria-selected'), 'true');
    assert(await panel.locator('img').evaluateAll(nodes => nodes.every(image => image.complete && image.naturalWidth > 0)));
    return { dateChangeStartsNewCycle: true, imageCount: items.length, revealedAfterImages: true };
  } finally { gate.release(); }
});

check('calendar-focused-tab-does-not-revert-after-loading', async ({ page }) => {
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const tab = index => page.getByRole('tab', { name: new RegExp(`^${weekdays[index]}`) });
  async function assertSelected(index) {
    await ready(page);
    // 旧焦点恢复可能再触发一轮切换，必须检查就绪后的稳定结果。
    await page.waitForTimeout(180);
    const selected = tab(index);
    assert.equal(await selected.getAttribute('aria-selected'), 'true', `完成加载后应停留在${weekdays[index]}，不能被旧焦点切回周六`);
    assert(await selected.evaluate(node => node === document.activeElement), `完成加载后焦点应位于当前${weekdays[index]}标签`);
    const panel = page.locator('.page-load-content .calendar-day-panel:not([aria-hidden="true"])');
    assert.equal(await panel.getAttribute('aria-labelledby'), await selected.getAttribute('id'), '显示面板必须对应当前选中的星期');
    const titles = await panel.locator('h4').allTextContents();
    assert.deepEqual(titles.sort(), calendar.items.filter(item => item.weekday === index).map(item => item.title).sort(), '面板内容必须属于目标星期');
  }
  await page.goto(`${baseUrl}/calendar?day=5`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  // 首次从 body 切换不会捕获旧标签，必须先制造已有周六焦点的真实前提。
  await tab(5).click();
  await tab(5).click();
  assert(await tab(5).evaluate(node => node === document.activeElement), '测试必须从聚焦的周六开始');
  const paths = new Set(calendar.items.filter(item => item.weekday === 0).map(item => item.cover_url));
  const matches = url => paths.has(url.pathname);
  const gate = await hold(page, matches);
  const requested = page.waitForRequest(request => matches(new URL(request.url())));
  try {
    await tab(0).click();
    await requested;
    await assertWaiting(page);
    assert(gate.blocked > 0, '测试必须在旧标签已聚焦时实际等待目标日期的新图片');
    gate.release();
    await assertSelected(0);
    const clicks = [1, 4, 6, 5, 0];
    for (const index of clicks) {
      await tab(index).click();
      await assertSelected(index);
    }
    const keys = [['ArrowRight', 1], ['ArrowRight', 2], ['ArrowLeft', 1]];
    for (const [key, index] of keys) {
      await page.keyboard.press(key);
      await assertSelected(index);
    }
    return { initialFocusedDay: '周六', slowImageTarget: '周一', stableClicks: clicks.map(index => weekdays[index]), keyboardSwitches: keys.map(([key, index]) => `${key}:${weekdays[index]}`) };
  } finally { gate.release(); }
});

check('calendar-season-cycle-waits-for-data-and-images', async ({ page }) => {
  await page.goto(`${baseUrl}/calendar?day=0`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const season = '202607';
  const seasonRequest = url => url.pathname === '/api/v1/calendar' && url.searchParams.get('season') === season;
  await page.route(url => seasonRequest(url), route => route.fulfill({ json: { ...calendar, season, items: calendar.items.map(item => ({ ...item, cover_url: `${item.cover_url}?season=${season}` })) } }));
  const dataGate = await hold(page, seasonRequest);
  const imageRequest = url => url.pathname.startsWith('/__visual__/calendar/') && url.searchParams.get('season') === season;
  const imageGate = await hold(page, imageRequest);
  const dataRequested = page.waitForRequest(request => seasonRequest(new URL(request.url())));
  const imageRequested = page.waitForRequest(request => imageRequest(new URL(request.url())));
  try {
    await page.getByRole('button', { name: '上一季度', exact: true }).click();
    await dataRequested;
    await assertWaiting(page);
    dataGate.release();
    await imageRequested;
    await assertWaiting(page);
    assert(imageGate.blocked > 0, '季度数据返回后，还必须等待新季度图片');
    imageGate.release();
    await ready(page);
    await page.getByRole('heading', { name: '2026 年 7 月新番', exact: true }).waitFor();
    assert(await page.locator('.page-load-content .calendar-day-panel img').evaluateAll(nodes => nodes.length > 0 && nodes.every(image => image.complete && image.naturalWidth > 0)));
    return { seasonChangeStartsNewCycle: true, waitedForDataAndImages: true };
  } finally { dataGate.release(); imageGate.release(); }
});

check('settings-hash-scroll-after-ready', async ({ page }) => {
  await page.addInitScript(() => {
    window.__hiddenPageScrolls = [];
    addEventListener('scroll', () => {
      if (document.querySelector('.page-load-boundary')?.getAttribute('data-ready') === 'false') window.__hiddenPageScrolls.push(scrollY);
    });
  });
  const matches = url => url.pathname === '/api/v1/settings/tmdb';
  const gate = await hold(page, matches);
  const requested = page.waitForRequest(request => matches(new URL(request.url())));
  try {
    await page.goto(`${baseUrl}/settings#tmdb`, { waitUntil: 'domcontentloaded' });
    await requested;
    await assertWaiting(page);
    assert.equal(await page.evaluate(() => scrollY), 0, '隐藏阶段不得执行哈希定位滚动');
    assert.equal(await page.locator('.page-load-content #tmdb').isVisible(), false, '目标区域须等数据就绪后显示');
    assert(await page.evaluate(() => window.__hiddenPageScrolls.every(value => value === 0)), '骨架期间不能短暂滚动到隐藏内容');
    gate.release();
    await ready(page);
    await page.waitForFunction(() => {
      const target = document.getElementById('tmdb');
      if (!target || scrollY <= 0) return false;
      const rect = target.getBoundingClientRect();
      const atDocumentEnd = document.documentElement.scrollHeight - innerHeight - scrollY <= 2;
      return rect.top < innerHeight && rect.bottom > 0 && (Math.abs(rect.top) <= 2 || atDocumentEnd);
    });
    return { hiddenStageScrollY: 0, visibleStageScrollY: await page.evaluate(() => scrollY), hashTargetPositionedAfterReveal: true };
  } finally { gate.release(); }
});

check('shows-image-decode', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLImageElement.prototype.decode;
    window.__imageDecodeStarted = 0;
    const gate = new Promise(resolve => { window.__releaseImageDecode = resolve; });
    HTMLImageElement.prototype.decode = async function () {
      window.__imageDecodeStarted++;
      await original.call(this);
      await gate;
    };
  });
  await page.goto(`${baseUrl}/shows`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__imageDecodeStarted > 0);
  await assertWaiting(page);
  assert(await page.locator('.page-load-content img').evaluateAll(nodes => nodes.every(image => image.complete)), '测试应在图片网络加载完成后单独阻塞解码');
  await page.evaluate(() => window.__releaseImageDecode());
  await ready(page);
  return { decodeWaited: true };
});

check('shows-switch-posters-to-cards-waits-for-fanart', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mooncell-shows-view', 'posters'));
  await page.goto(`${baseUrl}/shows`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.locator('.page-load-content .show-poster-grid').waitFor();
  const matches = url => /\/api\/v1\/shows\/\d+\/artwork\/fanart$/.test(url.pathname);
  const gate = await hold(page, matches);
  const requested = page.waitForRequest(request => matches(new URL(request.url())));
  try {
    await page.getByRole('radio', { name: '卡片视图', exact: true }).click();
    await requested;
    await assertWaiting(page);
    assert(gate.blocked > 0, '切换到卡片视图必须实际等待此前未加载的fanart');
    const fallback = page.locator('.page-load-fallback');
    await fallback.locator('.show-card-grid').waitFor();
    assert.equal(await fallback.locator('.show-poster-grid').count(), 0, '等待时必须显示目标卡片视图的骨架');
    assert.equal(await fallback.getByRole('radio', { name: '卡片视图', exact: true }).getAttribute('aria-checked'), 'true');
    const grid = page.locator('.page-load-content .show-card-grid');
    assert.equal(await grid.locator('.show-card-fanart').count(), shows.length, '目标卡片须隐藏挂载以启动全部fanart请求');
    gate.release();
    await ready(page);
    await grid.waitFor();
    assert(await grid.locator('img').evaluateAll(nodes => nodes.length > 0 && nodes.every(image => image.complete && image.naturalWidth > 0)), 'fanart和海报全部就绪后再显示新视图');
    assert.equal(await page.getByRole('radio', { name: '卡片视图', exact: true }).getAttribute('aria-checked'), 'true');
    return { from: 'posters', to: 'cards', fanartRequests: gate.blocked, targetSkeleton: true, waitedForImages: true };
  } finally { gate.release(); }
});

check('shows-cached-data-background-refresh', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const gate = await hold(page, url => url.pathname === '/api/v1/shows');
  try {
    await page.locator('.top-nav-list a[href="/feeds"]').click();
    await ready(page);
    await page.locator('.top-nav-list a[href="/shows"]').click();
    await ready(page);
    assert(gate.blocked > 0, '测试必须实际挂起缓存数据的后台刷新');
    assert.equal(await page.locator('.page-load-content .show-card-reveal').count(), shows.length);
    assert.equal(await page.locator('.page-load-content').isVisible(), true, '缓存数据已完整存在时，不应等待后台刷新结束');
    return { cachedDataVisibleDuringRefresh: true, pendingRefreshes: gate.blocked };
  } finally { gate.release(); }
});

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: argument('--channel', 'msedge') });
  const results = [];
  try {
    for (const test of cases.filter(test => test.name.includes(argument('--case', '')))) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
      const fixture = await installFixtures(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error)));
      const started = performance.now();
      try {
        const details = await test.run({ page, fixture });
        assert.deepEqual(pageErrors, [], '页面出现未处理的脚本异常');
        assert.deepEqual(fixture.unmocked, [], '浏览器夹具缺少接口');
        results.push({ name: test.name, passed: true, durationMs: Math.round(performance.now() - started), details });
        console.log(`PASS ${test.name}`);
      } catch (error) {
        const screenshot = path.join(output, `${test.name}-failure.png`);
        await page.screenshot({ path: screenshot, timeout: 5000 }).catch(() => {});
        results.push({ name: test.name, passed: false, error: error.stack || String(error), pageErrors, unmocked: fixture.unmocked, screenshot });
        console.error(`FAIL ${test.name}: ${error.message}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  assert(results.length > 0, '没有匹配的测试');
  const report = { baseUrl, passed: results.every(result => result.passed), results };
  const reportPath = path.join(output, 'result.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${results.filter(result => result.passed).length}/${results.length} 项通过；报告：${reportPath}`);
  if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
