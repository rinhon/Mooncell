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
  await waitPageReady(page);
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

async function waitPageReady(page) {
  await page.locator('.page-load-boundary[data-ready="true"]').waitFor();
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
    const grid = page.locator('.page-load-content .show-card-grid');
    await grid.waitFor({ state: 'attached', timeout: 5000 });
    await grid.getByText(shows[0].name, { exact: true }).first().waitFor({ state: 'attached' });
    await page.waitForTimeout(200);
    assert.equal(await grid.locator('.show-card-reveal').count(), shows.length, '数据到达后应隐藏挂载全部卡片以加载图片');
    assert(images.blocked > 0, '测试必须实际阻塞图片请求');
    assert.equal(await grid.isVisible(), false, '图片未就绪时不能提前显示番剧内容');
    await page.locator('.page-load-boundary[data-ready="false"]').waitFor();
    await page.getByRole('status', { name: '正在加载番剧订阅', exact: true }).waitFor();
    const allImages = await grid.locator('img').evaluateAll(nodes => ({ count: nodes.length, eager: nodes.every(image => image.loading === 'eager' || image.complete), offscreen: nodes.some(image => image.getBoundingClientRect().top > innerHeight) }));
    assert(allImages.offscreen, '测试必须覆盖屏外图片');
    assert(allImages.eager, '隐藏挂载时屏外 lazy 图片也必须主动加载');
    images.release();
    await waitPageReady(page);
    await grid.waitFor({ state: 'visible' });
    assert(await grid.locator('img').evaluateAll(nodes => nodes.length > 0 && nodes.every(image => image.complete && image.naturalWidth > 0)), '全部图片就绪后再整体显示');
    assert.equal(await page.getByRole('status', { name: '正在加载番剧订阅', exact: true }).count(), 0);
    return { renderedCards: shows.length, blockedImages: images.blocked, imageCount: allImages.count, includesOffscreenImages: true, revealedTogether: true };
  } finally { images.release(); }
});

check('calendar-slow-images', async ({ page }) => {
  const images = await deferImages(page);
  try {
    await page.goto(`${baseUrl}/calendar?day=0`, { waitUntil: 'domcontentloaded' });
    const panel = page.locator('.page-load-content .calendar-day-panel:not([aria-hidden="true"])');
    const items = calendar.items.filter(item => item.weekday === 0);
    await panel.locator('article.calendar-item').first().waitFor({ state: 'attached', timeout: 5000 });
    assert.equal(await panel.locator('article.calendar-item').count(), items.length);
    await panel.locator('h4').getByText(items[0].title, { exact: true }).waitFor({ state: 'attached' });
    await page.waitForTimeout(200);
    assert(images.blocked > 0, '测试必须实际阻塞日历封面请求');
    assert.equal(await panel.isVisible(), false, '封面未完成时应保留整体骨架');
    await page.getByRole('status', { name: '正在加载季度日历', exact: true }).waitFor();
    images.release();
    await waitPageReady(page);
    await panel.locator('h4').getByText(items[0].title, { exact: true }).waitFor();
    assert.equal(await panel.locator('.calendar-cover-skeleton').count(), 0);
    assert(await panel.locator('img').evaluateAll(nodes => nodes.every(image => image.complete && image.naturalWidth > 0)));
    return { renderedCards: items.length, blockedImages: images.blocked, revealedTogether: true };
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
    await page.goto(`${baseUrl}/calendar?day=0`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('.page-load-content .calendar-day-panel:not([aria-hidden="true"]) article.calendar-item')
      .filter({ has: page.locator('h4').getByText(item.title, { exact: true }) });
    await card.locator('.calendar-cover-skeleton').waitFor({ state: 'attached' });
    assert.equal(await card.isVisible(), false, '等待失败资源响应期间页面仍应隐藏');
    release();
    await waitPageReady(page);
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

async function detailReturnContext(page, view) {
  const filter = '第';
  assert(shows.filter(show => `${show.name}${show.metadata_title || ''}`.includes(filter)).length >= 12, '返回滚动测试需要足够的筛选结果');
  await page.goto(`${baseUrl}/shows?${new URLSearchParams({ q: filter })}`);
  await selectView(page, view);
  // Responsive columns can keep the eleventh item inside the first viewport.
  const target = page.locator(view === 'cards' ? '.show-card-reveal a[aria-label$="详情"]' : '.show-poster-tile').last();
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(450);
  assert(await page.evaluate(() => scrollY) > 300, '测试必须从已滚动的番剧页进入详情');
  // Native focus/scroll handling may move the viewport before the link's click handler runs.
  await target.evaluate(node => node.addEventListener('click', () => {
    window.__detailReturnScroll = scrollY;
  }, { once: true, capture: true }));
  const detailPath = await target.getAttribute('href');
  await target.click({ position: { x: 15, y: 15 } });
  const expectedScroll = await page.evaluate(() => window.__detailReturnScroll);
  await page.waitForURL(url => url.pathname === detailPath);
  await page.locator('.page-load-content .detail-title h1').waitFor();
  // Simulate a preference changed elsewhere while this list's return context remains intact.
  await page.evaluate(() => localStorage.setItem('mooncell-shows-view', 'list'));
  await page.locator('.detail-back').click();
  await waitView(page, view);
  assert.equal(new URL(page.url()).searchParams.get('q'), filter);
  assert.equal(await page.getByPlaceholder('搜索订阅名称或 TMDB 名称').inputValue(), filter);
  await page.waitForFunction(expected => Math.abs(scrollY - expected) <= 5, expectedScroll);
  assert.equal(await page.evaluate(() => localStorage.getItem('mooncell-shows-view')), 'list', '恢复列表状态不应覆盖独立保存的偏好');
  const restoredScroll = await page.evaluate(() => scrollY);
  await target.click({ position: { x: 15, y: 15 } });
  await page.locator('.page-load-content .detail-title h1').waitFor();
  await page.goBack();
  await waitView(page, view);
  await page.waitForFunction(expected => Math.abs(scrollY - expected) <= 5, restoredScroll);
  assert.equal(new URL(page.url()).searchParams.get('q'), filter);
  return { filter, restoredView: view, linkReturnScroll: restoredScroll, historyReturnScroll: await page.evaluate(() => scrollY) };
}

check('detail-return-context', ({ page }) => detailReturnContext(page, 'posters'));
check('detail-return-context-cards', ({ page }) => detailReturnContext(page, 'cards'));

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

async function recordCardEntry(page, selector) {
  await page.addInitScript(selector => {
    window.__cardEntryFrames = [];
    window.__stopCardEntry = false;
    const sample = () => {
      [...document.querySelectorAll(selector)].slice(0, 6).forEach((node, index) => {
        if (!node.getBoundingClientRect().height) return;
        const style = getComputedStyle(node);
        const transform = new DOMMatrixReadOnly(style.transform);
        window.__cardEntryFrames.push({ index, time: performance.now(), opacity: Number(style.opacity), y: transform.m42, scale: transform.a, filter: style.filter, pageReady: document.querySelector('.page-load-boundary')?.getAttribute('data-ready') === 'true' });
      });
      if (!window.__stopCardEntry) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, selector);
}

async function assertFirstCardsAnimate(page, count, { pageReadyOnly = false } = {}) {
  await page.waitForTimeout(1100);
  const frames = await page.evaluate(() => {
    window.__stopCardEntry = true;
    return window.__cardEntryFrames;
  });
  return Array.from({ length: count }, (_, index) => {
    const samples = frames.filter(frame => frame.index === index && (!pageReadyOnly || frame.pageReady));
    assert(samples.length > 3, `第 ${index + 1} 张卡片必须被逐帧采样`);
    assert(samples[0].opacity < .01, `第 ${index + 1} 张卡片不应首帧直接出现`);
    assert(samples.some(frame => frame.opacity > .01 && frame.opacity < .99), `第 ${index + 1} 张卡片应经过真实淡入`);
    assert(samples.at(-1).opacity > .99, `第 ${index + 1} 张卡片应完成入场`);
    return { index, frames: samples.length, initialOpacity: samples[0].opacity, finalOpacity: samples.at(-1).opacity };
  });
}

for (const revisit of [false, true]) {
  check(revisit ? 'shows-card-entry-on-revisit' : 'shows-card-entry-after-images', async ({ page, context }) => {
    if (revisit) await context.addInitScript(() => sessionStorage.setItem('mooncell-visited-routes', JSON.stringify(['/shows'])));
    await recordCardEntry(page, '.page-load-content .show-card-grid > .masonry__item');
    const images = await deferImages(page);
    try {
      await page.goto(`${baseUrl}/shows`, { waitUntil: 'domcontentloaded' });
      const grid = page.locator('.page-load-content .show-card-grid');
      await grid.locator('.show-card-reveal').first().waitFor({ state: 'attached' });
      await page.locator('.page-load-boundary[data-ready="false"]').waitFor();
      await page.waitForTimeout(250);
      assert(images.blocked > 0, '测试必须实际阻塞卡片图片');
      assert.equal(await grid.isVisible(), false, '等待图片时只能显示卡片骨架');
      const hiddenFrames = await page.evaluate(() => window.__cardEntryFrames.filter(frame => !frame.pageReady));
      assert(hiddenFrames.length > 3, '应采样到图片等待阶段');
      assert(!hiddenFrames.some(frame => frame.opacity > .01 && frame.opacity < .99), '入场动画不能在隐藏加载阶段提前消耗');
      images.release();
      await waitPageReady(page);
      const firstRow = await assertFirstCardsAnimate(page, 3, { pageReadyOnly: true });
      const visibleFrames = await page.evaluate(() => window.__cardEntryFrames.filter(frame => frame.pageReady));
      const starts = [];
      for (let index = 0; index < 3; index++) {
        const frames = visibleFrames.filter(frame => frame.index === index);
        assert(frames.some(frame => frame.opacity > .01 && frame.opacity < .99), '图片就绪后卡片仍应有真实淡入');
        starts.push(frames.find(frame => frame.opacity > .01 && frame.opacity < .99).time);
        assert(frames.some(frame => frame.scale < .999), '卡片应复用海报视图的轻微缩放入场');
        assert(frames.some(frame => frame.filter !== 'none' && /blur\(/.test(frame.filter)), '卡片应复用海报视图的模糊入场');
      }
      assert(starts[1] - starts[0] > 10 && starts[2] - starts[1] > 10, '首行卡片应逐张错峰入场');
      const heights = await grid.locator('[data-slot="card"]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      assert(heights.every(height => Math.abs(height - 440) < .5), '入场完成后仍应保持440px固定高度');
      return { revisit, firstRow, staggerMs: [starts[1] - starts[0], starts[2] - starts[1]], revealedAfterImages: true, samePosterEntry: true, cardHeight: 440 };
    } finally { images.release(); }
  });
}

check('shows-card-fanart-hover', async ({ page }) => {
  await page.route('**/api/v1/shows', route => route.fulfill({ json: shows.map(show => ({ ...show, clearlogo_ready: true })) }));
  await page.goto(`${baseUrl}/shows`);
  await waitView(page, 'cards');
  const card = page.locator('.show-card-reveal [data-slot="card"]').first();
  await card.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(1100);
  const measure = () => card.evaluate(node => {
    const bounds = element => { const r = element.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; };
    const scale = image => new DOMMatrixReadOnly(getComputedStyle(image).transform).a;
    return { card: bounds(node), title: bounds(node.querySelector('.line-clamp-2')), fanart: scale(node.querySelector('.show-card-fanart')), poster: scale(node.querySelector('img[src*="/artwork/poster"]')), logo: scale(node.querySelector('img[src*="/artwork/clearlogo"]')) };
  });
  const before = await measure();
  await card.hover({ position: { x: 35, y: 80 } });
  await page.waitForTimeout(120);
  const early = await measure();
  await page.waitForTimeout(120);
  const middle = await measure();
  await page.waitForTimeout(850);
  const after = await measure();
  assert(early.fanart > 1.02 && early.fanart - 1 > middle.fanart - early.fanart, 'fanart应快速响应后逐渐减速');
  assert(Math.abs(after.fanart - 1.04) < .001, '仅fanart应放大到1.04');
  for (const field of ['x', 'y', 'width', 'height']) {
    assert(Math.abs(after.card[field] - before.card[field]) < .5, `卡片${field}不得随悬停变化`);
    assert(Math.abs(after.title[field] - before.title[field]) < .5, `标题${field}不得随悬停变化`);
  }
  assert.equal(after.poster, 1, '内嵌小海报保持原尺寸');
  assert.equal(after.logo, 1, '透明Logo保持原尺寸');
  await page.mouse.move(1, 1);
  await page.waitForTimeout(1000);
  assert(Math.abs((await measure()).fanart - 1) < .001, '移开后fanart应平滑恢复');
  return { earlyScale: early.fanart, middleScale: middle.fanart, finalScale: after.fanart, stationaryCard: true, stationaryPosterAndLogo: true };
});

check('masonry-entry-on-revisit', async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem('mooncell-visited-routes', JSON.stringify(['/feeds'])));
  await recordCardEntry(page, '.feed-list[aria-label="订阅与合集"] > .masonry__item');
  await page.goto(`${baseUrl}/feeds`);
  await page.getByRole('list', { name: '订阅与合集', exact: true }).waitFor();
  const firstRow = await assertFirstCardsAnimate(page, 3);
  const layout = await page.getByRole('list', { name: '订阅与合集', exact: true }).evaluate(node => {
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
    };
    const cards = [...node.querySelectorAll('.feed-card')].map(bounds);
    const top = Math.min(...cards.map(card => card.top));
    return {
      grid: bounds(node),
      container: bounds(node.parentElement),
      cards,
      row: cards.filter(card => Math.abs(card.top - top) <= 1).sort((a, b) => a.left - b.left),
    };
  });
  assert(Math.abs(layout.grid.left - layout.container.left) <= 1 && Math.abs(layout.grid.right - layout.container.right) <= 1,
    '订阅列表应铺满可用容器，不再按固定卡片宽度截短');
  assert(Math.abs(layout.row[0].left - layout.grid.left) <= 1 && Math.abs(layout.row.at(-1).right - layout.grid.right) <= 1,
    '首行卡片应均分可用宽度并对齐列表左右边界');
  assert(layout.cards.every(card => Math.abs(card.width - layout.row[0].width) <= 1), '订阅卡片应保持等宽');
  assert(layout.cards.every(card => card.height >= 190), '订阅卡片应保持190px最小高度，允许状态标签换行时撑开');
  return { firstRow, columns: layout.row.length, availableWidth: layout.container.width, cardSize: [layout.cards[0].width, layout.cards[0].height] };
});

check('bento-entry-and-pointer-effects', async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.setItem('mooncell-visited-routes', JSON.stringify(['/'])));
  await recordCardEntry(page, '.magic-bento .dashboard-stat-strip:not([role="status"]) .dashboard-stat');
  await page.goto(baseUrl);
  await page.getByRole('region', { name: '状态总览', exact: true }).waitFor();
  const firstRow = await assertFirstCardsAnimate(page, 4);
  const card = page.locator('.dashboard-today');
  await card.hover();
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.dashboard-today')).getPropertyValue('--magic-bento-intensity')) > .9);
  await card.click({ position: { x: 15, y: 15 } });
  await card.locator('.magic-bento-wave').waitFor();
  await card.locator('.magic-bento-wave').waitFor({ state: 'detached' });
  return { firstRow, pointerGlow: true, clickWave: true };
});

check('bento-entry-on-touch', async ({ page }) => {
  await recordCardEntry(page, '.magic-bento .dashboard-stat-strip:not([role="status"]) .dashboard-stat');
  await page.goto(baseUrl);
  await page.getByRole('region', { name: '状态总览', exact: true }).waitFor();
  const firstCard = await assertFirstCardsAnimate(page, 1);
  assert.equal(await page.locator('.magic-bento').getAttribute('data-magic-bento-enabled'), 'false');
  return { firstCard, touchEntry: true, pointerEffects: false };
}, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

check('card-entry-reduced-motion', async ({ page }) => {
  await recordCardEntry(page, '.magic-bento .dashboard-stat-strip:not([role="status"]) .dashboard-stat, .feed-list[aria-label="订阅与合集"] > .masonry__item');
  await page.goto(baseUrl);
  await page.getByRole('region', { name: '状态总览', exact: true }).waitFor();
  await page.waitForTimeout(100);
  await page.locator('.top-nav-list a[href="/feeds"]').click();
  await page.getByRole('list', { name: '订阅与合集', exact: true }).waitFor();
  await page.waitForTimeout(100);
  const frames = await page.evaluate(() => { window.__stopCardEntry = true; return window.__cardEntryFrames; });
  assert(frames.length > 0);
  assert(frames.every(frame => frame.opacity === 1), '减少动态效果时卡片应直接可见，不能先隐藏');
  assert.equal(await page.locator('.feed-list[data-motion]').count(), 0);
  return { frames: frames.length, directlyVisible: true };
}, { reducedMotion: 'reduce' });

check('reduced-motion-images', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`);
  await waitView(page, 'cards');
  const image = page.locator('.show-card-grid img.fade-in-image').first();
  await image.waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector('.show-card-grid img.fade-in-image');
    return node && node.complete && node.naturalWidth > 0 && node.dataset.loaded === 'true';
  });
  // Motion writes its final DOM styles in the frame following React's loaded-state commit.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
