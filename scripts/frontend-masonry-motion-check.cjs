/* Calendar entry-motion regression with deterministic API/image fixtures.
 * node scripts\frontend-masonry-motion-check.cjs --base-url http://127.0.0.1:5173
 * Optional: --case split-observer --channel msedge
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFixtures, loadPlaywright, calendar } = require('./lib/frontend-fixture.cjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const baseUrl = new URL(argument('--base-url', 'http://127.0.0.1:5173')).origin;
const output = path.resolve(__dirname, '..', '.cache', 'frontend-masonry-motion-check');
const itemSelector = '.page-load-content .calendar-day-panel:not([aria-hidden="true"]) .masonry__item';
const items = Array.from({ length: 15 }, (_, index) => ({
  ...calendar.items[index],
  id: index + 1,
  title: `日历动效回归 ${String(index + 1).padStart(2, '0')}`,
  weekday: 5,
  liked: false,
  cover_url: `/__visual__/calendar/${index + 1}.svg`,
}));

async function installMotionProbe(page, splitObserver) {
  await page.addInitScript(({ selector, splitObserver }) => {
    const trace = window.__masonryMotionTrace = { frames: [], deliveries: [], recording: true };
    const ready = () => document.querySelector('.page-load-boundary')?.getAttribute('data-ready') === 'true';
    function sample(now) {
      if (!trace.recording) return;
      const nodes = [...document.querySelectorAll(selector)];
      if (nodes.length) trace.frames.push({
        time: Math.round(now * 100) / 100,
        ready: ready(),
        opacity: nodes.map(node => Number(getComputedStyle(node).opacity)),
      });
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
    if (!splitObserver) return;

    const NativeIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver = class extends NativeIntersectionObserver {
      constructor(callback, options) {
        let connected = true;
        super((entries, observer) => {
          const calendarEntries = entries.filter(entry => entry.isIntersecting && entry.target.matches(selector));
          if (calendarEntries.length < 4) return callback(entries, observer);
          calendarEntries.sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top || left.boundingClientRect.left - right.boundingClientRect.left);
          const rowTop = calendarEntries[0].boundingClientRect.top;
          const firstRow = calendarEntries.filter(entry => Math.abs(entry.boundingClientRect.top - rowTop) < 1);
          if (firstRow.length < 4) return callback(entries, observer);
          const left = firstRow.slice(0, Math.ceil(firstRow.length / 2));
          const leftTargets = new Set(left.map(entry => entry.target));
          const right = entries.filter(entry => !leftTargets.has(entry.target));
          const deliver = (batch, side) => {
            if (!connected) return;
            trace.deliveries.push({ time: performance.now(), ready: ready(), side, ids: batch.filter(entry => entry.isIntersecting).map(entry => entry.target.getAttribute('data-id')) });
            callback(batch, observer);
          };
          // The first delivery queues Masonry's flush before the adjacent-frame
          // second delivery. A per-batch rank reset then produces two waves.
          requestAnimationFrame(() => {
            if (!connected) return;
            deliver(left, 'left');
            requestAnimationFrame(() => deliver(right, 'right'));
          });
        }, options);
        this.cancelQueuedMotionDelivery = () => { connected = false; };
      }
      disconnect() {
        this.cancelQueuedMotionDelivery();
        super.disconnect();
      }
    };
  }, { selector: itemSelector, splitObserver });
}

async function holdImages(page) {
  let release;
  let blocked = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/__visual__/calendar/*.svg', async route => {
    blocked++;
    await gate;
    await route.fallback().catch(() => {});
  });
  return { release, get blocked() { return blocked; } };
}

async function finishTrace(page) {
  return page.evaluate(selector => {
    const trace = window.__masonryMotionTrace;
    trace.recording = false;
    const cards = [...document.querySelectorAll(selector)].map(node => ({
      id: node.getAttribute('data-id'),
      top: node.getBoundingClientRect().top,
      left: node.getBoundingClientRect().left,
    }));
    const rowTop = Math.min(...cards.map(card => card.top));
    return { ...trace, cards, firstRow: cards.flatMap((card, index) => Math.abs(card.top - rowTop) < 1 ? [index] : []) };
  }, itemSelector);
}

function assertSingleWave(trace) {
  assert(trace.firstRow.length >= 8, '宽屏夹具必须在同一行容纳至少 8 张卡片');
  const frames = trace.frames.filter(frame => frame.ready && frame.opacity.length === items.length);
  const animatedFrames = frames.filter(frame => trace.firstRow.some(index => frame.opacity[index] > .005 && frame.opacity[index] < .995));
  assert(animatedFrames.length >= 8, '必须采样正常入场过程，不能因关闭动效或提前播放完毕而误通过');
  const violations = [];
  for (const frame of frames) {
    for (let column = 1; column < trace.firstRow.length; column++) {
      const left = trace.firstRow[column - 1];
      const right = trace.firstRow[column];
      if (frame.opacity[right] > frame.opacity[left] + .005) violations.push({ time: frame.time, left: column - 1, right: column, leftOpacity: frame.opacity[left], rightOpacity: frame.opacity[right] });
    }
  }
  assert.equal(violations.length, 0, `同一行应从左到右连续入场，右侧不得越过左侧进度：${JSON.stringify(violations.slice(0, 3))}`);
  assert(frames.at(-1).opacity.every(opacity => opacity >= .999), '可见的 15 张卡片应完成入场');
  return { firstRowCount: trace.firstRow.length, sampledFrames: trace.frames.length, animatedFrames: animatedFrames.length };
}

async function checkWave({ page, splitObserver }) {
  await installMotionProbe(page, splitObserver);
  const images = await holdImages(page);
  try {
    await page.goto(`${baseUrl}/calendar?day=5`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 15, itemSelector);
    await page.waitForTimeout(300);
    assert.equal(images.blocked, items.length, '测试必须实际阻塞全部 15 张封面');
    assert.equal(await page.locator('.page-load-boundary').getAttribute('data-ready'), 'false', '图片未就绪时页面必须保持加载状态');
    const hidden = await page.evaluate(() => window.__masonryMotionTrace.frames.filter(frame => !frame.ready && frame.opacity.length === 15));
    assert(hidden.length >= 5, '必须实际记录隐藏预加载阶段');
    assert(hidden.every(frame => frame.opacity.every(opacity => opacity <= .001)), '隐藏预加载期间不得提前播放卡片入场动画');
    images.release();
    await page.locator('.page-load-boundary[data-ready="true"]').waitFor();
    await page.waitForTimeout(1900);
    const trace = await finishTrace(page);
    fs.writeFileSync(path.join(output, `${splitObserver ? 'split-observer' : 'slow-images'}-frames.json`), `${JSON.stringify(trace, null, 2)}\n`);
    if (splitObserver) {
      const visibleDeliveries = trace.deliveries.filter(delivery => delivery.ready);
      assert(visibleDeliveries.some(delivery => delivery.side === 'left') && visibleDeliveries.some(delivery => delivery.side === 'right'), '必须实际将首行左右两半分到相邻帧交付，不能空跑');
    }
    return { ...assertSingleWave(trace), hiddenFrames: hidden.length, splitObserver, splitDeliveries: trace.deliveries.length };
  } finally { images.release(); }
}

async function checkOffscreen({ page }) {
  await page.goto(`${baseUrl}/calendar?day=5`, { waitUntil: 'domcontentloaded' });
  await page.locator('.page-load-boundary[data-ready="true"]').waitFor();
  await page.waitForTimeout(1300);
  const hidden = await page.locator(itemSelector).evaluateAll(nodes => nodes.map((node, index) => ({ index, top: node.getBoundingClientRect().top, opacity: Number(getComputedStyle(node).opacity) })).filter(card => card.top > innerHeight + 50));
  assert(hidden.length > 0, '窄屏必须包含屏外卡片');
  assert(hidden.every(card => card.opacity <= .001), '屏外卡片应等待滚动触发，不能随首屏一起播放');
  const index = hidden.at(-1).index;
  await page.locator(itemSelector).nth(index).evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForFunction(({ selector, index }) => Number(getComputedStyle(document.querySelectorAll(selector)[index]).opacity) >= .999, { selector: itemSelector, index });
  return { waitingOffscreenCards: hidden.length, revealedAfterScroll: index + 1 };
}

const cases = [
  { name: 'slow-images-single-wave', viewport: { width: 2160, height: 1400 }, run: context => checkWave({ ...context, splitObserver: false }) },
  { name: 'split-observer-single-wave', viewport: { width: 2160, height: 1400 }, run: context => checkWave({ ...context, splitObserver: true }) },
  { name: 'narrow-screen-scroll-reveal', viewport: { width: 760, height: 850 }, run: checkOffscreen },
];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: argument('--channel', 'msedge') });
  const results = [];
  try {
    for (const test of cases.filter(test => test.name.includes(argument('--case', '')))) {
      const context = await browser.newContext({ viewport: test.viewport, timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference' });
      const fixture = await installFixtures(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.route('**/api/v1/calendar*', route => route.fulfill({ json: { ...calendar, items } }));
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error)));
      const started = performance.now();
      try {
        const details = await test.run({ page });
        assert.deepEqual(pageErrors, [], '页面出现未处理的脚本异常');
        assert.deepEqual(fixture.unmocked, [], '所有后端请求必须由确定性夹具覆盖');
        results.push({ name: test.name, passed: true, durationMs: Math.round(performance.now() - started), details });
        console.log(`PASS ${test.name}`);
      } catch (error) {
        const trace = await page.evaluate(() => window.__masonryMotionTrace).catch(() => undefined);
        if (trace) fs.writeFileSync(path.join(output, `${test.name}-failure-frames.json`), `${JSON.stringify(trace, null, 2)}\n`);
        results.push({ name: test.name, passed: false, error: error.stack || String(error), pageErrors, unmocked: fixture.unmocked });
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
