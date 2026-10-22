/* P1 DOM behavior regression. Run against a production preview:
 * node scripts\frontend-p1-check.cjs --base-url http://127.0.0.1:4174
 * Uses deterministic fixtures; never calls the live backend or edits live data.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFixtures, loadPlaywright, shows, calendar } = require('./lib/frontend-fixture.cjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const baseUrl = new URL(argument('--base-url', 'http://127.0.0.1:4174')).origin;
const output = path.resolve(__dirname, '..', '.cache', 'frontend-p1-check');
const caseFilter = argument('--case', '');
const views = {
  cards: { label: '卡片视图', selector: '.show-card-grid' },
  posters: { label: '海报视图', selector: '.show-poster-grid' },
  list: { label: '列表视图', selector: '.show-row-list' },
};
const cases = [];
const check = (name, run, options = {}) => cases.push({ name, run, options });

async function waitView(page, view) {
  await page.getByRole('radio', { name: views[view].label, exact: true }).waitFor();
  await page.waitForFunction(label => {
    const controls = [...document.querySelectorAll('[role="radio"]')];
    return controls.some(node => node.textContent.trim() === label && node.getAttribute('aria-checked') === 'true');
  }, views[view].label);
  await page.locator(views[view].selector).waitFor({ state: 'visible' });
}

async function selectView(page, view) {
  await page.getByRole('radio', { name: views[view].label, exact: true }).click();
  await waitView(page, view);
}

async function deferImages(page) {
  let release;
  let blocked = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/*', async route => {
    if (route.request().resourceType() === 'image') {
      blocked++;
      await gate;
    }
    await route.fallback().catch(() => {});
  });
  return { release, get blocked() { return blocked; } };
}

check('shows-slow-images', async ({ page }) => {
  const images = await deferImages(page);
  try {
    await page.goto(`${baseUrl}/shows`, { waitUntil: 'domcontentloaded' });
    await page.locator('.show-card-grid').waitFor({ state: 'visible', timeout: 5000 });
    const grid = page.locator('.show-card-grid');
    await grid.getByText(shows[0].name, { exact: true }).first().waitFor({ state: 'visible' });
    assert.equal(await grid.locator('.show-card-reveal').count(), shows.length, '数据到达后应立即创建全部卡片');
    assert(images.blocked > 0, '测试必须实际阻塞图片请求');
    assert(await grid.locator('img').first().evaluate(image => !image.complete && image.naturalWidth === 0), '卡片应先于图片解码出现');
    assert.equal(await page.getByRole('status', { name: '正在加载番剧订阅' }).count(), 0);
    return { renderedCards: shows.length, blockedImages: images.blocked };
  } finally { images.release(); }
});

check('calendar-slow-images', async ({ page }) => {
  const images = await deferImages(page);
  try {
    await page.goto(`${baseUrl}/calendar`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /^周一/ }).click();
    const panel = page.locator('.calendar-day-panel:not([aria-hidden="true"])');
    const items = calendar.items.filter(item => item.weekday === 0);
    await panel.locator('article.calendar-item').first().waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await panel.locator('article.calendar-item').count(), items.length);
    await panel.locator('h4').getByText(items[0].title, { exact: true }).waitFor({ state: 'visible' });
    assert(images.blocked > 0, '测试必须实际阻塞日历封面请求');
    assert(await panel.locator('.calendar-cover-skeleton').count() > 0, '仅单张封面保持加载骨架');
    assert.equal(await panel.getByRole('status', { name: '正在加载季度日历' }).count(), 0, '不再用整体骨架隐藏卡片');
    return { renderedCards: items.length, blockedImages: images.blocked };
  } finally { images.release(); }
});

check('calendar-image-failure', async ({ page }) => {
  const item = calendar.items.find(item => item.weekday === 0);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**${item.cover_url}`, async route => {
    await gate;
    await route.fulfill({ status: 200, contentType: 'image/png', body: 'intentionally invalid image' }).catch(() => {});
  });
  try {
    await page.goto(`${baseUrl}/calendar`);
    await page.getByRole('tab', { name: /^周一/ }).click();
    const card = page.locator('.calendar-day-panel:not([aria-hidden="true"]) article.calendar-item')
      .filter({ has: page.locator('h4').getByText(item.title, { exact: true }) });
    await card.locator('.calendar-cover-skeleton').waitFor({ state: 'visible' });
    release();
    await card.getByRole('img', { name: '暂无封面', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await card.locator('.calendar-cover-skeleton').count(), 0, '图片失败后应移除骨架');
    assert.equal(await card.locator('img').count(), 0, '图片失败后应移除损坏的图片');
    await card.locator('h4').getByText(item.title, { exact: true }).waitFor({ state: 'visible' });
    return { failedCover: item.title, placeholderVisible: true, skeletonRemoved: true };
  } finally { release(); }
});

check('view-preference', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`);
  await waitView(page, 'cards');
  for (const view of ['list', 'posters']) {
    await selectView(page, view);
    assert.equal(await page.evaluate(() => localStorage.getItem('mooncell-shows-view')), view);
    await page.reload();
    await waitView(page, view);
  }
  await page.evaluate(() => localStorage.setItem('mooncell-shows-view', 'invalid-view'));
  await page.reload();
  await waitView(page, 'cards');
  return { persistedViews: ['list', 'posters'], invalidPreferenceFallback: 'cards' };
});

check('detail-return-context', async ({ page }) => {
  const filter = '第';
  assert(shows.filter(show => `${show.name}${show.metadata_title || ''}`.includes(filter)).length >= 12, '返回滚动测试需要足够的筛选结果');
  await page.goto(`${baseUrl}/shows?${new URLSearchParams({ q: filter })}`);
  await selectView(page, 'posters');
  const target = page.locator('.show-poster-tile').nth(10);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(450);
  const expectedScroll = await page.evaluate(() => scrollY);
  assert(expectedScroll > 300, '测试必须从已滚动的番剧页进入详情');
  const detailPath = await target.getAttribute('href');
  await target.click({ position: { x: 15, y: 15 } });
  await page.waitForURL(url => url.pathname === detailPath);
  await page.locator('.show-detail h1').waitFor();
  // Simulate a preference changed elsewhere while this list's return context remains intact.
  await page.evaluate(() => localStorage.setItem('mooncell-shows-view', 'list'));
  await page.locator('.detail-back').click();
  await waitView(page, 'posters');
  assert.equal(new URL(page.url()).searchParams.get('q'), filter);
  assert.equal(await page.getByPlaceholder('搜索订阅名称或 TMDB 名称').inputValue(), filter);
  await page.waitForFunction(expected => Math.abs(scrollY - expected) <= 5, expectedScroll);
  assert.equal(await page.evaluate(() => localStorage.getItem('mooncell-shows-view')), 'list', '恢复列表状态不应覆盖独立保存的偏好');
  const restoredScroll = await page.evaluate(() => scrollY);
  await target.click({ position: { x: 15, y: 15 } });
  await page.locator('.show-detail h1').waitFor();
  await page.goBack();
  await waitView(page, 'posters');
  await page.waitForFunction(expected => Math.abs(scrollY - expected) <= 5, restoredScroll);
  assert.equal(new URL(page.url()).searchParams.get('q'), filter);
  return { filter, restoredView: 'posters', linkReturnScroll: restoredScroll, historyReturnScroll: await page.evaluate(() => scrollY) };
});

check('storage-denied', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`);
  await waitView(page, 'cards');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('此测试禁止访问 localStorage', 'SecurityError'); },
    });
  });
  await page.reload();
  await waitView(page, 'cards');
  assert(await page.evaluate(() => { try { void window.localStorage; return false; } catch { return true; } }));
  await selectView(page, 'list');
  await selectView(page, 'posters');
  await page.reload();
  await waitView(page, 'cards');
  return { storageDenied: true, switchingWorks: true, reloadFallback: 'cards' };
});

check('card-hover-stays-in-place', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`);
  await waitView(page, 'cards');
  const card = page.locator('.show-card-grid .show-card-reveal > .h-full').first();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(900);
  const before = await card.boundingBox();
  assert(before);
  await page.mouse.move(before.x + 30, before.y + 90);
  await page.waitForTimeout(650);
  const after = await card.boundingBox();
  const translation = await card.evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m42);
  assert(Math.abs(after.y - before.y) <= .5, `包含内部控件的卡片悬停后位移 ${after.y - before.y}px`);
  assert(Math.abs(translation) <= .25, `卡片保留了上浮 transform：${translation}px`);
  return { verticalShift: after.y - before.y, translateY: translation };
});

check('dashboard-status-overview', async ({ page }) => {
  await page.goto(baseUrl);
  const strip = page.getByRole('region', { name: '状态总览', exact: true });
  await strip.getByRole('link', { name: /^订阅健康：7/ }).waitFor();
  assert.equal(await strip.locator('.dashboard-stat').count(), 4);
  assert.deepEqual(await strip.locator('a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), ['/feeds', '/downloads', '/review']);
  await page.getByRole('region', { name: '今日放送', exact: true }).locator('.dashboard-schedule-list').waitFor();
  await page.getByRole('region', { name: '正在下载', exact: true }).locator('.dashboard-download-list').waitFor();
  assert.equal(await page.locator('.accordion-gallery, .continue-countdown').count(), 0, '首页使用状态总览，不再自动轮播');
  return { statCards: 4, todaySchedule: true, activeDownloads: true, galleryRemoved: true };
});

check('organizer-production-route', async ({ page }) => {
  await page.goto(`${baseUrl}/organizer`);
  await page.waitForURL(url => url.pathname === '/downloads');
  await page.getByRole('heading', { name: '下载中心', exact: true }).waitFor();
  await page.locator('.sm-trigger').click();
  const menu = page.getByRole('dialog', { name: '探索 Mooncell' });
  await menu.waitFor();
  assert.equal(await menu.locator('a[href="/organizer"]').count(), 0, '生产主导航不再展示整理演示页');
  assert.equal(await menu.getByRole('link', { name: /整理/ }).count(), 0);
  assert.equal(await menu.locator('a[aria-current="page"]').getAttribute('href'), '/downloads');
  await page.keyboard.press('Escape');
  return { organizerRedirect: '/downloads', organizerNavigationEntries: 0 };
}, { viewport: { width: 768, height: 1000 } });

check('reduced-motion-images', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`);
  await waitView(page, 'cards');
  const image = page.locator('.show-card-grid img.fade-in-image').first();
  await image.waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector('.show-card-grid img.fade-in-image');
    return node && node.complete && node.naturalWidth > 0 && node.dataset.loaded === 'true';
  });
  const style = await image.evaluate(node => {
    const value = getComputedStyle(node);
    return { opacity: value.opacity, transitionDuration: value.transitionDuration, animationDuration: value.animationDuration };
  });
  assert.equal(style.opacity, '1', '减少动态效果时已加载图片应直接显示');
  assert(style.transitionDuration.split(',').every(value => parseFloat(value) === 0), '减少动态效果时图片不应淡入');
  return style;
}, { reducedMotion: 'reduce' });

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  const results = [];
  try {
    for (const test of cases.filter(test => test.name.includes(caseFilter))) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', ...test.options });
      const fixture = await installFixtures(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error)));
      const started = performance.now();
      try {
        const details = await test.run({ page, context });
        assert.deepEqual(pageErrors, [], '页面出现未处理的脚本异常');
        assert.deepEqual(fixture.unmocked, [], '浏览器夹具缺少接口');
        const result = { name: test.name, passed: true, durationMs: Math.round(performance.now() - started), details };
        results.push(result);
        console.log(`PASS ${test.name}`);
      } catch (error) {
        const screenshot = path.join(output, `${test.name}-failure.png`);
        await page.screenshot({ path: screenshot, fullPage: false, timeout: 5000 }).catch(() => {});
        results.push({ name: test.name, passed: false, durationMs: Math.round(performance.now() - started), error: error.stack || String(error), pageErrors, unmocked: fixture.unmocked, screenshot });
        console.error(`FAIL ${test.name}: ${error.message}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  assert(results.length > 0, `没有匹配的测试：${caseFilter}`);
  const report = { baseUrl, passed: results.every(result => result.passed), checkedAt: new Date().toISOString(), results };
  const reportPath = path.join(output, 'result.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${results.filter(result => result.passed).length}/${results.length} 项通过；报告：${reportPath}`);
  if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
