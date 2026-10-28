/* Calendar tabs accept one buffered switch while cards are loading or entering.
 * node scripts\frontend-calendar-tab-lock-check.cjs --base-url http://127.0.0.1:5173
 * Optional: --case wide --channel msedge
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
const output = path.resolve(__dirname, '..', '.cache', 'frontend-calendar-tab-lock-check');
const tabsSelector = '.page-load-content .calendar-week-tabs [role="tab"]';
const fallbackTabsSelector = '.page-load-boundary[data-ready="false"] .page-load-fallback .calendar-week-tabs [role="tab"]';
const cardSelector = '.page-load-content .calendar-day-panel:not([aria-hidden="true"]) .masonry__item';
const items = [5, 0, 6].flatMap((weekday, dayIndex) => Array.from({ length: dayIndex === 2 ? 3 : 15 }, (_, index) => ({
  ...calendar.items[index], id: dayIndex * 100 + index + 1, weekday, liked: false,
  title: `星期 ${weekday} · 动效卡片 ${index + 1}`,
  cover_url: `/__visual__/calendar/${dayIndex * 100 + index + 1}.svg`,
})));

async function installTrace(page) {
  await page.addInitScript(({ tabsSelector, cardSelector }) => {
    const trace = window.__calendarTabLockTrace = { frames: [], recording: true };
    const blocked = node => node?.disabled || node?.getAttribute('aria-disabled') === 'true';
    const sample = now => {
      if (!trace.recording) return;
      const tabs = [...document.querySelectorAll(tabsSelector)];
      if (tabs.length) trace.frames.push({
        time: now,
        ready: document.querySelector('.page-load-boundary')?.dataset.ready === 'true',
        selected: tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'),
        busy: document.querySelector('.page-load-content .calendar-week-tabs')?.getAttribute('aria-busy') === 'true',
        enabled: tabs.filter(tab => !tab.hidden).every(tab => !blocked(tab)) &&
          !blocked(document.querySelector('.page-load-content .calendar-week-tabs .overflow-trigger')),
        cards: [...document.querySelectorAll(cardSelector)].map(card => {
          const box = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          return { opacity: Number(style.opacity), filter: style.filter, visible: box.top < innerHeight && box.bottom > 0 };
        }),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { tabsSelector, cardSelector });
}

async function waitForEntry(page, day) {
  await page.waitForFunction(({ cardSelector, tabsSelector, day }) => {
    const tabs = [...document.querySelectorAll(tabsSelector)];
    return document.querySelector('.page-load-boundary')?.dataset.ready === 'true' &&
      (day === undefined || tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true') === day) &&
      [...document.querySelectorAll(cardSelector)].some(card => {
        const box = card.getBoundingClientRect();
        const opacity = Number(getComputedStyle(card).opacity);
        return box.top < innerHeight && box.bottom > 0 && opacity > .001 && opacity < .995;
      });
  }, { cardSelector, tabsSelector, day }, { polling: 'raf' });
}

async function waitForIdle(page, day) {
  await page.waitForFunction(({ tabsSelector, day }) => {
    const tabs = [...document.querySelectorAll(tabsSelector)];
    const list = document.querySelector('.page-load-content .calendar-week-tabs');
    return document.querySelector('.page-load-boundary')?.dataset.ready === 'true' && list &&
      list.getAttribute('aria-busy') !== 'true' &&
      (day === undefined || tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true') === day);
  }, { tabsSelector, day }, { polling: 'raf' });
}

async function selectedDay(page) {
  return page.locator(tabsSelector).evaluateAll(tabs => tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
}

async function assertEnabled(page) {
  const states = await page.locator(`${tabsSelector}, .page-load-content .calendar-week-tabs .overflow-trigger`).evaluateAll(tabs =>
    tabs.filter(tab => !tab.hidden).map(tab => ({ label: tab.textContent, blocked: tab.disabled || tab.getAttribute('aria-disabled') === 'true' })));
  assert(states.length && states.every(state => !state.blocked), '加载期间星期 tab 和更多入口仍应允许输入');
}

async function assertBusy(page, day) {
  assert.equal(await selectedDay(page), day, '加载期间输入只能预存，不得立即切换');
  assert.equal(await page.locator('.page-load-content .calendar-week-tabs').getAttribute('aria-busy'), 'true');
  await assertEnabled(page);
}

// 在一次 evaluate 内发送全部输入，不等待 Playwright 的稳定性检查或逐次渲染。
async function mouseBurst(page, days, selector = tabsSelector) {
  await page.evaluate(({ tabsSelector, days }) => {
    const tabs = [...document.querySelectorAll(tabsSelector)];
    for (const day of days) {
      const tab = tabs[day];
      tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      tab.focus();
      tab.click();
    }
  }, { tabsSelector: selector, days });
}

async function nextFrames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function completed(card) {
  return card.opacity >= .999 && (card.filter === 'none' || card.filter === 'blur(0px)');
}

async function assertCompleted(page) {
  const states = await page.locator(cardSelector).evaluateAll(cards => cards.filter(card => {
    const rect = card.getBoundingClientRect();
    return rect.top < innerHeight && rect.bottom > 0;
  }).map(card => ({ opacity: Number(getComputedStyle(card).opacity), filter: getComputedStyle(card).filter })));
  assert(states.length && states.every(completed), '加载完成时可见卡片应已完成淡入和模糊动效');
}

async function finishTrace(page, name) {
  const trace = await page.evaluate(() => {
    window.__calendarTabLockTrace.recording = false;
    return window.__calendarTabLockTrace;
  });
  fs.writeFileSync(path.join(output, `${name}-frames.json`), `${JSON.stringify(trace, null, 2)}\n`);
  const entry = trace.frames.filter(frame => frame.ready && frame.cards.some(card => card.visible && card.opacity > .001 && card.opacity < .995));
  assert(trace.frames.every(frame => frame.enabled), '整个加载和切换过程不得重新禁用星期输入');
  assert(entry.every(frame => frame.busy), '卡片仍在入场时应保持忙碌状态');
  const changes = [];
  for (let index = 1; index < trace.frames.length; index++) {
    const before = trace.frames[index - 1], after = trace.frames[index];
    if (before.selected === after.selected) continue;
    const visible = before.cards.filter(card => card.visible);
    assert(visible.every(completed), `星期 ${before.selected} 切换到 ${after.selected} 前最后一帧的可见卡片必须已完成入场`);
    changes.push([before.selected, after.selected]);
  }
  return { entryFrames: entry.length, changes };
}

async function wide({ page }) {
  await installTrace(page);
  await page.goto(`${baseUrl}/calendar?day=5`, { waitUntil: 'domcontentloaded' });
  await waitForEntry(page, 5);
  await mouseBurst(page, [0, 6, 1, 6]);
  await assertBusy(page, 5);
  await waitForEntry(page, 0);
  await assertBusy(page, 0);

  // 消费首条请求后，新一组入场仍能再保存一条键盘请求。
  await nextFrames(page);
  await page.locator(`${tabsSelector}[aria-selected="true"]`).evaluate(node => node.focus());
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)].indexOf(document.activeElement) === 1, tabsSelector);
  await page.keyboard.press('Enter');
  await mouseBurst(page, [6, 5]);
  await assertBusy(page, 0);
  await waitForIdle(page, 1);
  await page.getByText('暂无播出安排', { exact: true }).waitFor();
  await nextFrames(page);
  assert.equal(await selectedDay(page), 1, '后续点击不得覆盖首次键盘预输入或积累成多条队列');

  // 空日期空闲时首个输入立即执行，同一帧只再接受一个预输入。
  await mouseBurst(page, [5, 0, 6, 1]);
  await waitForEntry(page, 5);
  await waitForIdle(page, 0);
  await assertCompleted(page);
  await nextFrames(page);
  assert.equal(await selectedDay(page), 0, '同帧连续输入应执行首个切换及唯一的首条预输入');
  const trace = await finishTrace(page, 'wide-buffer');
  assert(trace.entryFrames >= 10, '必须采样真实入场过程');
  assert.deepEqual(trace.changes, [[5, 0], [0, 1], [1, 5], [5, 0]], '首条请求应依次执行，重复点击不得新增切换');

  await page.locator(`${tabsSelector}[aria-selected="true"]`).evaluate(node => node.focus());
  await page.keyboard.press('ArrowRight');
  await waitForIdle(page, 1);
  return { ...trace, firstRequestWins: true, sameFrameInputBuffered: true, mouseAndKeyboardAccepted: true };
}

async function waitForImageLoadingTabs(page, day) {
  await page.waitForFunction(({ fallbackTabsSelector, day }) => {
    const tabs = [...document.querySelectorAll(fallbackTabsSelector)];
    const content = document.querySelector('.page-load-content');
    return tabs.length === 8 && tabs[day]?.getAttribute('aria-selected') === 'true' &&
      [...(content?.querySelectorAll('img') ?? [])].some(image => !image.complete);
  }, { fallbackTabsSelector, day }, { polling: 'raf' });
  const states = await page.locator(fallbackTabsSelector).evaluateAll(tabs => tabs.filter(tab => !tab.hidden).map(tab => ({
    disabled: tab.disabled || tab.getAttribute('aria-disabled') === 'true',
    inert: Boolean(tab.closest('[inert]')),
    visible: tab.getBoundingClientRect().width > 0 && getComputedStyle(tab).visibility !== 'hidden',
  })));
  assert(states.length && states.every(state => !state.disabled && !state.inert && state.visible), '图片未完成时骨架中的真实星期 tab 应保持可见且能接收输入');
}

async function imageLoading({ page }) {
  await installTrace(page);
  await page.goto(`${baseUrl}/calendar?day=5`, { waitUntil: 'domcontentloaded' });
  await waitForImageLoadingTabs(page, 5);
  await mouseBurst(page, [0, 6, 1, 6], fallbackTabsSelector);
  assert.equal(await page.locator('.page-load-boundary').getAttribute('data-ready'), 'false', '夹具应在图片实际等待阶段接收预输入');
  await assertBusy(page, 5);
  await waitForEntry(page, 5);
  await assertBusy(page, 5);
  await mouseBurst(page, [6, 1]);

  // 首次图片和入场完成后才执行周一；下一次图片等待仍可保留一条新请求。
  await waitForImageLoadingTabs(page, 0);
  await mouseBurst(page, [6, 1, 5], fallbackTabsSelector);
  await assertBusy(page, 0);
  await waitForEntry(page, 0);
  await assertBusy(page, 0);
  await waitForIdle(page, 6);
  await assertCompleted(page);
  await nextFrames(page);
  assert.equal(await selectedDay(page), 6, '图片等待期间应只保留首个请求，并在图片与入场完成后自动执行');
  const trace = await finishTrace(page, 'image-loading-buffer');
  assert(trace.entryFrames >= 10, '图片加载场景也必须验证真实卡片入场完成');
  assert.deepEqual(trace.changes, [[5, 0], [0, 6]], '图片等待与随后入场期间的重复点击不得覆盖首次预输入');
  return { ...trace, fallbackTabsInteractive: true, bufferedDuringImageLoading: true, nextCycleAcceptsInput: true };
}

async function reduced({ page }) {
  await installTrace(page);
  await page.goto(`${baseUrl}/calendar?day=5`, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page, 5);
  await assertEnabled(page);
  await mouseBurst(page, [0, 6, 1]);
  await waitForIdle(page, 6);
  await assertCompleted(page);
  await nextFrames(page);
  assert.equal(await selectedDay(page), 6, '减少动态效果时也应消费唯一预输入，不等待不存在的动画');
  const trace = await finishTrace(page, 'reduced-buffer');
  assert.equal(trace.entryFrames, 0, '减少动态效果时不应播放卡片入场动画');
  assert.deepEqual(trace.changes, [[5, 0], [0, 6]], '减少动态效果也必须先完成首次切换的加载周期，再执行预输入');
  return { ...trace, noAnimationDelay: true, bufferedDay: 6 };
}

async function empty({ page }) {
  await installTrace(page);
  await page.goto(`${baseUrl}/calendar?day=1`, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page, 1);
  await page.getByText('暂无播出安排', { exact: true }).waitFor();
  assert.equal(await page.locator(cardSelector).count(), 0);
  await mouseBurst(page, [0, 1, 6]);
  await waitForEntry(page, 0);
  await waitForIdle(page, 1);
  await nextFrames(page);
  assert.equal(await selectedDay(page), 1, '预输入到空日期后不能等待不存在的 Masonry 回调');
  await mouseBurst(page, [6]);
  await waitForIdle(page, 6);
  await assertCompleted(page);
  const trace = await finishTrace(page, 'empty-buffer');
  assert.deepEqual(trace.changes, [[1, 0], [0, 1], [1, 6]]);
  return { ...trace, emptyDayDrainsQueue: true, nextInputAccepted: true };
}

async function narrow({ page }) {
  await installTrace(page);
  await page.goto(`${baseUrl}/calendar?day=5`, { waitUntil: 'domcontentloaded' });
  await waitForEntry(page, 5);
  await assertEnabled(page);
  const overflow = page.getByRole('button', { name: '更多星期', exact: true });
  await overflow.evaluate(node => node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })));
  await page.getByRole('menu').waitFor();
  const sunday = page.getByRole('menuitem').filter({ hasText: /^周日/ });
  assert.equal(await sunday.getAttribute('aria-disabled'), null, '忙碌期间下拉星期选项必须允许输入');
  await sunday.evaluate((node, tabsSelector) => {
    node.click();
    const tabs = [...document.querySelectorAll(tabsSelector)];
    for (const day of [0, 1]) {
      tabs[day].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      tabs[day].click();
    }
  }, tabsSelector);
  await assertBusy(page, 5);
  await waitForIdle(page, 6);
  await nextFrames(page);
  assert.equal(await selectedDay(page), 6, '更多菜单的首条预输入应保留，后续可见 tab 点击不得覆盖');

  await mouseBurst(page, [0]);
  await waitForEntry(page, 0);
  await waitForIdle(page, 0);
  const pending = await page.locator(cardSelector).evaluateAll(cards => cards.filter(card => card.getBoundingClientRect().top > innerHeight && Number(getComputedStyle(card).opacity) <= .001).length);
  assert(pending > 0, '窄屏夹具必须仍有等待滚动的屏外卡片');
  await assertEnabled(page);
  await page.locator(cardSelector).last().evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await waitForEntry(page, 0);
  await assertBusy(page, 0);
  await waitForIdle(page, 0);
  assert(await page.locator(cardSelector).last().evaluate(node => Number(getComputedStyle(node).opacity) >= .999), '滚动触发的新卡片应能完成入场并恢复空闲');
  await assertEnabled(page);
  const trace = await finishTrace(page, 'narrow-buffer');
  assert.deepEqual(trace.changes, [[5, 6], [6, 0]]);
  return { ...trace, overflowInputBuffered: true, unplayedOffscreenCards: pending, scrollEntryCompletes: true };
}

const cases = [
  { name: 'wide-buffer-and-repeat', viewport: { width: 2160, height: 1400 }, run: wide },
  { name: 'image-loading-buffer', viewport: { width: 2160, height: 1400 }, imageDelayMs: 300, run: imageLoading },
  { name: 'reduced-motion-no-delay', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', run: reduced },
  { name: 'empty-day-buffer-drains', viewport: { width: 1440, height: 1000 }, run: empty },
  { name: 'narrow-overflow-and-offscreen', viewport: { width: 390, height: 900 }, run: narrow },
];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: argument('--channel', 'msedge') });
  const results = [];
  try {
    for (const test of cases.filter(test => test.name.includes(argument('--case', '')))) {
      const context = await browser.newContext({ viewport: test.viewport, timezoneId: 'Asia/Shanghai', reducedMotion: test.reducedMotion ?? 'no-preference' });
      const fixture = await installFixtures(context, { imageDelayMs: test.imageDelayMs ?? 0 });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.route('**/api/v1/calendar*', route => route.fulfill({ json: { ...calendar, items } }));
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error)));
      const started = performance.now();
      try {
        const details = await test.run({ page });
        assert.deepEqual(pageErrors, [], '页面不得出现未处理脚本异常');
        assert.deepEqual(fixture.unmocked, [], '所有后端请求必须由夹具覆盖');
        results.push({ name: test.name, passed: true, durationMs: Math.round(performance.now() - started), details });
        console.log(`PASS ${test.name}`);
      } catch (error) {
        const state = await page.evaluate(() => ({
          ready: document.querySelector('.page-load-boundary')?.dataset.ready,
          selected: document.querySelector('.page-load-content .calendar-week-tabs [aria-selected="true"]')?.textContent,
          busy: document.querySelector('.page-load-content .calendar-week-tabs')?.getAttribute('aria-busy'),
          trace: window.__calendarTabLockTrace,
        })).catch(() => null);
        fs.writeFileSync(path.join(output, `${test.name}-failure.json`), `${JSON.stringify(state, null, 2)}\n`);
        results.push({ name: test.name, passed: false, error: error.stack || String(error), pageErrors, unmocked: fixture.unmocked });
        console.error(`FAIL ${test.name}: ${error.message}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  assert(results.length, '没有匹配的测试');
  const reportPath = path.join(output, 'result.json');
  const passed = results.every(result => result.passed);
  fs.writeFileSync(reportPath, `${JSON.stringify({ baseUrl, passed, results }, null, 2)}\n`);
  console.log(`${results.filter(result => result.passed).length}/${results.length} 项通过；报告：${reportPath}`);
  if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
