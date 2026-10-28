/* P2–P6 behavior regression against a production preview.
 * node scripts\frontend-optimization-check.cjs --base-url http://127.0.0.1:4174
 * Optional: --case navigation --channel msedge
 * Deterministic local fixtures only. Failure cases never reach a real backend.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFixtures, loadPlaywright, shows } = require('./lib/frontend-fixture.cjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const baseUrl = new URL(argument('--base-url', 'http://127.0.0.1:4174')).origin;
const caseFilter = argument('--case', '');
const output = path.resolve(__dirname, '..', '.cache', 'frontend-optimization-check');
const cases = [];
const check = (name, run, options = {}) => cases.push({ name, run, options });
const region = (page, name) => page.getByRole('region', { name, exact: true });

async function dashboardReady(page) {
  await page.locator('.page-load-boundary[data-ready="true"]').waitFor();
  await region(page, '状态总览').getByRole('link', { name: /^订阅健康：7/ }).waitFor();
  await region(page, '正在下载').locator('.dashboard-download-list').waitFor();
  await region(page, '今日放送').locator('.dashboard-schedule-list').waitFor();
}

async function expectFocused(page, selector, message) {
  await page.waitForFunction(selector => document.querySelector(selector) === document.activeElement, selector);
  assert(await page.locator(selector).evaluate(node => node === document.activeElement), message || `焦点应位于 ${selector}`);
}

async function constrainVisibility(page, hidden) {
  // Exercise the same visibilitychange path as a background tab without relying
  // on the headless window manager's treatment of multiple foreground pages.
  await page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function recordMotion(page, pathname, selectors) {
  await page.evaluate(({ pathname, selectors }) => {
    window.__optimizationMotion = [];
    window.__optimizationMotionStop = false;
    const sample = () => {
      if (location.pathname === pathname) {
        for (const node of document.querySelectorAll(selectors)) {
          const box = node.getBoundingClientRect();
          if (!box.width || !box.height) continue;
          const style = getComputedStyle(node);
          const matrix = new DOMMatrixReadOnly(style.transform);
          window.__optimizationMotion.push({
            className: String(node.className), opacity: Number(style.opacity), x: matrix.m41, y: matrix.m42,
          });
        }
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    const tick = () => {
      sample();
      if (window.__optimizationMotionStop) observer.disconnect();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { pathname, selectors });
}

async function assertMotionSkipped(page) {
  await page.waitForTimeout(400);
  const samples = await page.evaluate(() => {
    window.__optimizationMotionStop = true;
    return window.__optimizationMotion;
  });
  assert(samples.length > 0, '动效采样必须覆盖真实 DOM');
  const displaced = samples.filter(sample => sample.opacity < .999 || Math.abs(sample.x) > .1 || Math.abs(sample.y) > .1);
  assert.deepEqual(displaced, [], '减少动态效果或复访时不应再次出现入场位移/淡入');
  return { samples: samples.length, displaced: displaced.length };
}

for (const theme of ['forest', 'ocean']) {
  check(`design-token-utilities-${theme}`, async ({ page }) => {
    await page.goto(`${baseUrl}/shows`);
    await page.locator('.page-load-content .show-card-grid').waitFor();
    const result = await page.evaluate(theme => {
      const root = document.documentElement;
      const previousTheme = root.dataset.theme;
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.inert = true;
      host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none';
      const probe = document.createElement('div');
      probe.className = 'text-caption text-muted bg-surface border border-border rounded-control';
      const reference = document.createElement('div');
      reference.style.cssText = 'color:var(--muted);background-color:var(--surface);border:1px solid var(--border);border-radius:var(--radius-control);font-size:12px';
      const small = document.createElement('span');
      small.className = 'text-small';
      const body = document.createElement('span');
      body.className = 'text-body';
      host.append(probe, reference, small, body);
      try {
        root.dataset.theme = theme;
        document.body.append(host);
        const snapshot = node => {
          const style = getComputedStyle(node);
          return {
            color: style.color, background: style.backgroundColor, borderColor: style.borderTopColor,
            borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle,
            radius: style.borderTopLeftRadius, fontSize: style.fontSize,
          };
        };
        return {
          theme, probe: snapshot(probe), reference: snapshot(reference),
          small: getComputedStyle(small).fontSize, body: getComputedStyle(body).fontSize,
        };
      } finally {
        host.remove();
        if (previousTheme === undefined) delete root.dataset.theme;
        else root.dataset.theme = previousTheme;
      }
    }, theme);
    assert.deepEqual(result.probe, result.reference, `${theme} 工具类应与运行时令牌的计算样式一致`);
    assert.equal(result.probe.radius, '8px');
    assert.equal(result.probe.fontSize, '12px');
    assert.equal(result.probe.borderWidth, '1px');
    assert.equal(result.probe.borderStyle, 'solid');
    assert.equal(result.small, '13px');
    assert.equal(result.body, '14px');
    return result;
  });
}

for (const width of [1024, 1280, 1440, 1920]) {
  check(`navigation-layout-${width}`, async ({ page }) => {
    await page.goto(`${baseUrl}/shows`);
    await page.locator('.page-load-content .show-card-grid').waitFor();
    await page.getByRole('button', { name: '更多导航', exact: true }).waitFor();
    const layout = await page.evaluate(() => {
      const selectors = ['.brand-mark', '.top-nav-list > a', '.notification-trigger', '.top-nav-more-trigger'];
      const nodes = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
      return {
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        headerHeight: document.querySelector('.top-navigation').getBoundingClientRect().height,
        items: nodes.map(node => {
          const box = node.getBoundingClientRect();
          return { label: node.getAttribute('aria-label') || node.textContent.trim(), x: box.x, right: box.right, width: box.width };
        }).sort((a, b) => a.x - b.x),
      };
    });
    assert.equal(layout.headerHeight, 78);
    assert(layout.scrollWidth <= width + 1, '桌面导航不得产生横向滚动');
    assert(layout.items.length >= 4, '品牌、主导航、通知和更多均应可见');
    for (const [index, item] of layout.items.entries()) {
      assert(item.width > 0 && item.x >= -1 && item.right <= width + 1, `顶栏控件超出视口：${item.label}`);
      if (index) assert(layout.items[index - 1].right <= item.x + 1, `顶栏控件重叠：${item.label}`);
    }
    assert.equal(await page.locator('.sm-trigger').isVisible(), false);
    assert.equal(await page.locator('.top-nav-list a[aria-current="page"]').getAttribute('href'), '/shows');
    return layout;
  }, { viewport: { width, height: 1000 } });
}

check('navigation-keyboard-more', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`);
  await page.locator('.page-load-content .show-card-grid').waitFor();
  await page.locator('.brand-mark').focus();
  const links = await page.locator('.top-nav-list > a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
  for (const href of links) {
    await page.keyboard.press('Tab');
    await expectFocused(page, `.top-nav-list > a[href="${href}"]`, '品牌之后应依路由顺序访问主导航');
  }
  await page.keyboard.press('Tab');
  await expectFocused(page, '.notification-trigger');
  await page.keyboard.press('Tab');
  await expectFocused(page, '.top-nav-more-trigger');
  await page.keyboard.press('Enter');
  const menu = page.locator('.top-nav-menu');
  await menu.waitFor();
  assert.equal(await menu.locator('a[href="/review"]').count(), 0, '更多菜单不再提供审核入口');
  await expectFocused(page, '.top-nav-menu a[href="/logs"]');
  await page.keyboard.press('ArrowDown');
  await expectFocused(page, '.top-nav-menu a[href="/settings"]');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await expectFocused(page, '.top-nav-more-trigger', 'Esc 关闭菜单后恢复触发器焦点');
  await page.keyboard.press('ArrowDown');
  await menu.waitFor();
  await page.keyboard.press('End');
  await expectFocused(page, '.top-nav-menu a[href="/settings"]');
  await page.keyboard.press('Enter');
  await page.waitForURL(url => url.pathname === '/settings');
  await page.waitForFunction(() => document.querySelector('.top-nav-more-trigger')?.classList.contains('active'));
  assert(await page.locator('.top-nav-more-trigger').evaluate(node => node.classList.contains('active')));
  return { tabOrder: ['品牌', ...links, '通知', '更多'], menuKeyboardNavigation: true, focusRestored: true };
});

check('navigation-overflow', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`);
  await page.locator('.page-load-content .show-card-grid').waitFor();
  const total = await page.locator('.top-nav-list > a').count();
  await page.addStyleTag({ content: '.top-nav { max-width: 260px; }' });
  await page.waitForFunction(total => document.querySelectorAll('.top-nav-list > a').length < total, total);
  const visible = await page.locator('.top-nav-list > a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
  await page.locator('.top-nav-more-trigger').click();
  await page.locator('.top-nav-menu').waitFor();
  const overflow = await page.locator('.top-nav-menu a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
  assert(overflow.includes('/calendar'), '末项日历在宽度不足时必须进入更多');
  assert.deepEqual([...visible, ...overflow.slice(0, 5 - visible.length)], ['/', '/shows', '/feeds', '/downloads', '/calendar']);
  await page.locator('.top-nav-menu a[href="/calendar"]').click();
  await page.waitForURL(url => url.pathname === '/calendar');
  return { visible, overflow, lastItemNavigable: true };
});

check('navigation-mobile-drawer-detail', async ({ page }) => {
  await page.goto(`${baseUrl}/shows/1`);
  await page.locator('.detail-title h1').waitFor();
  assert.equal(await page.locator('.top-nav').isVisible(), false);
  const trigger = page.getByRole('button', { name: '打开导航菜单', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: '探索 Mooncell', exact: true });
  await drawer.waitFor();
  assert.equal(await drawer.locator('a[aria-current="page"]').getAttribute('href'), '/shows', '详情子路由应高亮番剧');
  assert.equal(await drawer.getByText(/DASHBOARD|ANIME LIBRARY|UTILITIES|NAVIGATION/).count(), 0);
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await expectFocused(page, '.sm-trigger');
  await trigger.click();
  await drawer.locator('a[href="/calendar"]').click();
  await page.waitForURL(url => url.pathname === '/calendar');
  await drawer.waitFor({ state: 'hidden' });
  await trigger.click();
  await drawer.waitFor();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await drawer.waitFor({ state: 'hidden' });
  await page.locator('.top-nav').waitFor({ state: 'visible' });
  return { detailsHighlight: '/shows', escapeRestoresFocus: true, navigationClosesDrawer: true, desktopResizeClosesDrawer: true };
}, { viewport: { width: 375, height: 900 } });

check('navigation-desktop-detail-highlight', async ({ page }) => {
  await page.goto(`${baseUrl}/shows/1`);
  await page.locator('.detail-title h1').waitFor();
  assert.equal(await page.locator('.top-nav-list a[aria-current="page"]').getAttribute('href'), '/shows');
  assert.equal(await page.locator('.top-nav-indicator').count(), 1);
  return { detailsHighlight: '/shows', activeIndicators: 1 };
});

for (const reducedMotion of ['no-preference', 'reduce']) {
  check(`navigation-scrolled-indicator-${reducedMotion}`, async ({ page }) => {
    await page.goto(`${baseUrl}/shows`);
    await page.locator('.page-load-content .show-card-grid').waitFor();
    await page.waitForTimeout(700);
    const source = await page.evaluate(async () => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      // Let scrolling and the sticky header settle before recording either route.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__navigationTrack = { stopped: false, frames: [] };
      const sample = () => {
        const header = document.querySelector('.top-navigation').getBoundingClientRect();
        for (const node of document.querySelectorAll('.top-nav-indicator')) {
          const box = node.getBoundingClientRect();
          if (!box.width || !box.height) continue;
          window.__navigationTrack.frames.push({
            pathname: location.pathname, scrollY,
            x: box.left - header.left, y: box.top - header.top,
          });
        }
      };
      const tick = () => {
        if (window.__navigationTrack.stopped) return;
        sample();
        requestAnimationFrame(tick);
      };
      sample();
      requestAnimationFrame(tick);
      return { scrollY, height: document.documentElement.scrollHeight };
    });
    assert(source.scrollY > 500, '源页面必须真实滚动，才能覆盖吸顶导航的坐标边界');
    await page.locator('.top-nav-list a[href="/downloads"]').click();
    await page.waitForURL(url => url.pathname === '/downloads');
    await page.getByRole('heading', { name: '下载中心', exact: true }).waitFor();
    await page.getByRole('status', { name: '正在加载下载中心', exact: true }).waitFor({ state: 'hidden' });
    await page.waitForTimeout(800);
    const result = await page.evaluate(() => {
      window.__navigationTrack.stopped = true;
      const header = document.querySelector('.top-navigation').getBoundingClientRect();
      const label = document.querySelector('.top-nav-list a[aria-current="page"] .top-nav-label').getBoundingClientRect();
      return {
        frames: window.__navigationTrack.frames,
        scrollY, height: document.documentElement.scrollHeight,
        targetX: label.left - header.left,
      };
    });
    const first = result.frames.find(frame => frame.pathname === '/shows');
    const targetFrames = result.frames.filter(frame => frame.pathname === '/downloads');
    assert(first && targetFrames.length >= 2, '逐帧采样必须覆盖点击前后两个真实路由');
    assert(result.height < source.height - 100 && result.scrollY < source.scrollY - 100,
      '目标页面必须更短，并真实触发页面滚动位置收缩');
    const last = targetFrames.at(-1);
    const horizontalDistance = Math.abs(last.x - first.x);
    assert(horizontalDistance > 30, '指示条必须真实横向移动到另一项菜单');
    assert(Math.abs(last.x - result.targetX) <= 1, '动画结束后指示条应落在当前菜单下方');
    if (reducedMotion === 'no-preference') {
      const minX = Math.min(first.x, last.x), maxX = Math.max(first.x, last.x);
      assert(targetFrames.some(frame => frame.x > minX + 1 && frame.x < maxX - 1),
        '普通模式必须采到横向动画中间帧，防止静态截图掩盖轨迹问题');
    } else {
      assert(targetFrames.every(frame => Math.abs(frame.x - first.x) <= 1 || Math.abs(frame.x - last.x) <= 1),
        '减少动态效果时应直接到达终点，不应出现横向动画中间帧');
    }
    const ys = result.frames.map(frame => frame.y);
    const verticalRange = Math.max(...ys) - Math.min(...ys);
    assert(verticalRange <= 1, `指示条相对顶栏的纵向波幅不得超过 1px，实际为 ${verticalRange}px`);
    return {
      reducedMotion, samples: result.frames.length, horizontalDistance, verticalRange,
      sourceScrollY: source.scrollY, targetScrollY: result.scrollY,
      sourceHeight: source.height, targetHeight: result.height,
    };
  }, { reducedMotion });
}

check('dashboard-keyboard-and-notifications', async ({ page }) => {
  await page.goto(baseUrl);
  await dashboardReady(page);
  const strip = region(page, '状态总览');
  assert.deepEqual(await region(page, '正在下载').getByRole('progressbar').evaluateAll(nodes =>
    nodes.map(node => Number(node.getAttribute('aria-valuenow')))), [69, 57, 45], '下载接口使用0–100百分比，不能再次缩放');
  const cards = strip.locator('.dashboard-stat');
  assert.equal(await cards.count(), 4);
  await cards.first().focus();
  const names = [];
  for (let index = 0; index < 4; index++) {
    if (index) await page.keyboard.press('Tab');
    assert(await cards.nth(index).evaluate(node => node === document.activeElement), '四个指标必须顺序可键盘访问');
    names.push(await cards.nth(index).getAttribute('aria-label'));
  }
  assert(names.every(Boolean));
  assert.deepEqual(await strip.locator('a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), ['/feeds', '/downloads', '/review']);
  assert.equal(await strip.getByRole('link', { name: /^待审核：/ }).getAttribute('href'), '/review', '首页状态总览保留审核入口');
  await page.keyboard.press('Enter');
  const center = page.getByRole('dialog', { name: '提醒中心', exact: true });
  await center.waitFor();
  await center.getByText('正在同步本季发布信息', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await center.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.dashboard-stat-strip .dashboard-stat:last-child') === document.activeElement);
  assert(await cards.last().evaluate(node => node === document.activeElement), '首页指标打开的通知中心关闭后应回到原指标');
  return { statCards: names, notificationsOpenedByKeyboard: true, escapeRestoresStatFocus: true };
});

const moduleContent = {
  calendar: ['今日放送', '.dashboard-schedule-list'],
  downloads: ['正在下载', '.dashboard-download-list'],
  dashboard: ['最新发布', '.dashboard-release-list'],
  shows: ['最近添加', '.dashboard-poster-grid'],
};
for (const endpoint of ['dashboard', 'downloads', 'calendar', 'shows', 'notifications/summary']) {
  check(`dashboard-initial-failure-${endpoint.replaceAll('/', '-')}`, async ({ page }) => {
    let failedRequests = 0;
    await page.route(url => url.pathname === `/api/v1/${endpoint}`, async route => {
      failedRequests++;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: `模拟 ${endpoint} 不可用` }) });
    });
    await page.goto(baseUrl);
    await page.locator('.page-load-boundary[data-ready="true"]').waitFor();
    if (endpoint === 'notifications/summary') {
      await region(page, '状态总览').getByRole('button', { name: /^后台提醒读取失败/ }).waitFor();
    } else {
      await region(page, moduleContent[endpoint][0]).getByRole('alert').waitFor();
    }
    const unaffected = [];
    for (const [source, [name, selector]] of Object.entries(moduleContent)) {
      if (source === endpoint) continue;
      await region(page, name).locator(selector).waitFor();
      unaffected.push(name);
    }
    assert(failedRequests > 0, '测试必须真实命中接口故障');
    assert.equal(await region(page, '状态总览').locator('.dashboard-stat').count(), 4);
    return { failedEndpoint: endpoint, failedRequests, unaffectedModules: unaffected };
  });
}

check('dashboard-slow-shows-waits-for-complete-page', async ({ page }) => {
  let release;
  let blocked = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v1/shows', async route => {
    blocked++;
    await gate;
    await route.fallback().catch(() => {});
  });
  const started = performance.now();
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.page-load-content .dashboard-release-list').waitFor({ state: 'attached' });
    await page.locator('.page-load-boundary[data-ready="false"]').waitFor();
    await page.waitForTimeout(200);
    assert(blocked > 0, '测试必须真实阻塞番剧接口');
    assert.equal(await page.locator('.page-load-content .dashboard-release-list').isVisible(), false, '即使其他模块数据已完成，首页也应继续显示整体骨架');
    assert.equal(await page.locator('.page-load-content .dashboard-poster-grid').count(), 0);
    release();
    await dashboardReady(page);
    await region(page, '最近添加').locator('.dashboard-poster-grid').waitFor();
    return { completePageMs: Math.round(performance.now() - started), blockedRequests: blocked, revealedTogether: true };
  } finally { release(); }
});

check('dashboard-download-polling-visibility', async ({ page, fixture }) => {
  const downloadRequests = () => fixture.requests.filter(item => item === 'GET /downloads').length;
  await page.goto(baseUrl);
  await dashboardReady(page);
  await page.evaluate(() => {
    window.__dashboardReadyChanges = [];
    const boundary = document.querySelector('.page-load-boundary');
    new MutationObserver(() => window.__dashboardReadyChanges.push(boundary.getAttribute('data-ready')))
      .observe(boundary, { attributes: true, attributeFilter: ['data-ready'] });
  });
  const initial = downloadRequests();
  await page.waitForTimeout(5400);
  const visible = downloadRequests();
  assert(visible > initial, '页面可见时应在约 5 秒后刷新下载');
  await constrainVisibility(page, true);
  await page.waitForTimeout(150);
  const beforeHidden = downloadRequests();
  await page.waitForTimeout(5600);
  const afterHidden = downloadRequests();
  assert.equal(afterHidden, beforeHidden, '页面隐藏时必须停止下载轮询');
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/downloads');
  await constrainVisibility(page, false);
  await refreshed;
  assert(downloadRequests() > afterHidden, '恢复可见后应重新获取下载');
  assert.equal(await page.locator('.page-load-boundary').getAttribute('data-ready'), 'true');
  assert.equal(await page.evaluate(() => window.__dashboardReadyChanges.includes('false')), false, '后台轮询和可见性刷新不得把已显示页面切回骨架');
  return { initial, visible, beforeHidden, afterHidden, restoredVisible: downloadRequests(), visibility: 'synthetic visibilitychange' };
});

check('detail-visible-actions-and-artwork', async ({ page }) => {
  // Only the navigation contract is under test; stop before any real video
  // probing, streaming, progress update, or autoplay permission is involved.
  await page.route('**/api/v1/media/fixture-1/playback-info', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '回归测试仅验证播放导航状态，未打开媒体文件。' }),
  }));
  await page.goto(`${baseUrl}/shows/1`);
  await page.locator('.detail-title h1').waitFor();
  const poster = page.locator('.detail-poster');
  assert.equal(await poster.evaluate(node => node.tagName), 'DIV', '海报不再是隐式编辑按钮');
  assert.equal(await poster.getAttribute('tabindex'), null);
  await poster.click();
  assert.equal(await page.getByRole('dialog').count(), 0, '点击海报不应打开编辑弹窗');
  const primary = page.locator('.detail-primary-actions');
  const play = primary.getByRole('link', { name: /^继续观看/ });
  await play.waitFor();
  assert.equal(await play.getAttribute('href'), '/watch/fixture-1');
  await play.focus();
  assert(await play.evaluate(node => node === document.activeElement));
  await page.keyboard.press('Tab');
  const folder = primary.getByRole('button', { name: '打开文件夹', exact: true });
  assert(await folder.evaluate(node => node === document.activeElement), '播放之后应直接可达打开文件夹');
  await page.getByRole('button', { name: '作品操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '更换图片', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '上传番剧图片', exact: true });
  await upload.waitFor();
  await upload.getByRole('button', { name: '选择海报 poster图片', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await upload.waitFor({ state: 'hidden' });
  await play.click();
  await page.waitForURL(url => url.pathname === '/watch/fixture-1');
  assert.equal(await page.evaluate(() => history.state?.usr?.autoPlay), true, '主播放操作应携带 autoPlay 导航状态');
  await page.getByRole('heading', { name: '暂时无法播放', exact: true }).waitFor();
  return { posterHasNoEditAction: true, primaryPlay: '/watch/fixture-1', autoPlay: true, visibleFolderAction: true, artworkMenuOpensUpload: true };
});

check('feeds-no-container-tab-stop', async ({ page }) => {
  await page.goto(`${baseUrl}/feeds`);
  await page.locator('.feed-card').first().waitFor();
  const cards = page.locator('.feed-card');
  const tabStops = await cards.evaluateAll(nodes => nodes.map(node => ({ name: node.getAttribute('aria-label'), tabIndex: node.tabIndex })));
  assert(tabStops.length > 1);
  assert(tabStops.every(item => item.tabIndex === -1), '订阅卡片容器应跳过 Tab 顺序');
  const first = cards.first();
  const edit = first.getByRole('button', { name: `${shows[0].name}：编辑订阅`, exact: true });
  await edit.focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), `${shows[0].name}：刷新订阅`);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), `${shows[0].name}：更多操作`);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), `${shows[1].name}：编辑订阅`);
  return { containers: tabStops.length, containerTabStops: 0, controlsRemainAccessible: true };
});

check('error-toast-persists-and-closes', async ({ page }) => {
  let failedRequests = 0;
  await page.route('**/api/v1/shows/1/open-folder', async route => {
    failedRequests++;
    assert.equal(route.request().method(), 'POST');
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '模拟媒体目录暂时不可用，请检查挂载路径后重试。' }) });
  });
  await page.goto(`${baseUrl}/shows/1`);
  await page.locator('.detail-primary-actions').getByRole('button', { name: '打开文件夹', exact: true }).click();
  const toast = page.locator('.toast-notice--error');
  await toast.getByText('操作失败', { exact: true }).waitFor();
  await page.mouse.move(1, 1);
  await page.locator('.brand-mark').focus();
  await page.waitForTimeout(4200);
  assert.equal(await toast.isVisible(), true, '错误通知超过原有 3.6 秒后应继续显示');
  assert.equal(await toast.getAttribute('data-phase'), 'open');
  await toast.getByText('模拟媒体目录暂时不可用，请检查挂载路径后重试。', { exact: true }).waitFor();
  await toast.getByRole('button', { name: '关闭通知', exact: true }).click();
  await toast.waitFor({ state: 'hidden' });
  assert.equal(failedRequests, 1);
  return { survivedMs: 4200, manualCloseWorks: true, failedRequests };
});

check('reduced-motion-navigation', async ({ page }) => {
  await page.goto(`${baseUrl}/shows`);
  await page.locator('.page-load-content .show-card-grid').waitFor();
  // Navigation uses a static translate for placement; its motion is checked by
  // navigation-scrolled-indicator-reduce using actual positions across frames.
  await recordMotion(page, '/feeds', '.page-content, .feed-card-reveal');
  await page.locator('.top-nav-list a[href="/feeds"]').click();
  await page.locator('.feed-card').first().waitFor();
  return assertMotionSkipped(page);
}, { reducedMotion: 'reduce' });

check('route-revisit-skips-entry', async ({ page }) => {
  await page.goto(`${baseUrl}/feeds`);
  await page.locator('.feed-card').first().waitFor();
  await page.waitForTimeout(700);
  await page.locator('.top-nav-list a[href="/shows"]').click();
  await page.locator('.page-load-content .show-card-grid').waitFor();
  await page.waitForTimeout(700);
  await recordMotion(page, '/feeds', '.page-content, .feed-card-reveal');
  await page.locator('.top-nav-list a[href="/feeds"]').click();
  await page.locator('.feed-card').first().waitFor();
  return assertMotionSkipped(page);
});

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true, channel: argument('--channel', process.env.PLAYWRIGHT_CHANNEL || 'msedge') });
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
        const details = await test.run({ page, context, fixture });
        assert.deepEqual(pageErrors, [], '页面出现未处理的脚本异常');
        assert.deepEqual(fixture.unmocked, [], '浏览器夹具缺少接口');
        results.push({ name: test.name, passed: true, durationMs: Math.round(performance.now() - started), details });
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
