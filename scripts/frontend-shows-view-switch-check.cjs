/* Shows segmented-control motion regression with deterministic API/image fixtures.
 * node scripts\frontend-shows-view-switch-check.cjs --base-url http://127.0.0.1:5173
 * Optional: --case current-tap --channel msedge
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFixtures, loadPlaywright, shows } = require('./lib/frontend-fixture.cjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const baseUrl = new URL(argument('--base-url', 'http://127.0.0.1:5173')).origin;
const output = path.resolve(__dirname, '..', '.cache', 'frontend-shows-view-switch-check');
const groupSelector = '.page-load-content [role="radiogroup"][aria-label="切换番剧视图"]';
const views = [
  { value: 'cards', label: '卡片视图', content: '.show-card-grid' },
  { value: 'posters', label: '海报视图', content: '.show-poster-grid' },
  { value: 'list', label: '列表视图', content: '.show-row-list' },
];

async function installProbe(page) {
  await page.addInitScript(({ groupSelector }) => {
    localStorage.setItem('mooncell-shows-view', 'cards');
    // Avoid a route entrance transform changing geometry during this control test.
    sessionStorage.setItem('mooncell-visited-routes', JSON.stringify(['/shows']));
    const probe = window.__showsSwitchProbe = { lastPointer: null };
    probe.state = () => {
      const group = document.querySelector(groupSelector);
      if (!group) return null;
      const buttons = [...group.querySelectorAll('button[role="radio"]')];
      const selected = buttons.findIndex(button => button.getAttribute('aria-checked') === 'true');
      const button = buttons[selected];
      const thumb = group.querySelector('.rubber-segment__thumb');
      if (!button || !thumb) return null;
      const clipPath = getComputedStyle(thumb).clipPath;
      const raw = clipPath.match(/^inset\((.*?)\s+round\s/);
      if (!raw) return null;
      const values = raw[1].trim().split(/\s+/).map(parseFloat);
      const rightInset = values[1] ?? values[0];
      const leftInset = values[3] ?? values[1] ?? values[0];
      const thumbRect = thumb.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const left = thumbRect.left + leftInset;
      const right = thumbRect.right - rightInset;
      return {
        selected,
        checkedCount: buttons.filter(item => item.getAttribute('aria-checked') === 'true').length,
        ready: document.querySelector('.page-load-boundary')?.dataset.ready === 'true',
        clipPath,
        left,
        right,
        targetLeft: buttonRect.left,
        targetRight: buttonRect.right,
        centerX: (buttonRect.left + buttonRect.right) / 2,
        centerY: (buttonRect.top + buttonRect.bottom) / 2,
        error: Math.max(Math.abs(left - buttonRect.left), Math.abs(right - buttonRect.right)),
      };
    };
    document.addEventListener('pointerdown', event => {
      if (event.target.closest(groupSelector)) probe.lastPointer = {
        pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      };
    }, true);
  }, { groupSelector });
}

const state = page => page.evaluate(() => window.__showsSwitchProbe.state());

async function waitView(page, index) {
  await page.waitForFunction(index => {
    const current = window.__showsSwitchProbe.state();
    return current?.ready && current.selected === index && current.checkedCount === 1;
  }, index, { polling: 'raf' });
  await page.locator(`.page-load-content ${views[index].content}`).waitFor();
}

async function settled(page, index) {
  try {
    await page.waitForFunction(index => {
      const current = window.__showsSwitchProbe.state();
      return current?.ready && current.selected === index && current.error < 1;
    }, index, { polling: 'raf', timeout: 2000 });
  } catch {
    const actual = await state(page);
    assert.fail(`滑块未归位到${views[index].label}：${JSON.stringify(actual)}`);
  }
  const actual = await state(page);
  assert.equal(actual.checkedCount, 1, '必须只有一个选中的视图');
  return actual;
}

async function clickView(page, index) {
  const button = page.locator(groupSelector).getByRole('radio', { name: views[index].label, exact: true });
  const rect = await button.boundingBox();
  assert(rect, '真实页面的切换按钮必须可见');
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await waitView(page, index);
}

async function open(page) {
  await page.goto(`${baseUrl}/shows`, { waitUntil: 'domcontentloaded' });
  await waitView(page, 0);
  await settled(page, 0);
}

async function interruptTransition(page, cancel) {
  await open(page);
  await clickView(page, 2);
  // A real pointer can catch the expanded thumb before its delayed trailing edge lands.
  await page.waitForFunction(() => {
    const current = window.__showsSwitchProbe.state();
    return current?.ready && current.selected === 2 && current.error > 6 &&
      current.left < current.centerX - 2 && current.right > current.centerX + 2;
  }, undefined, { polling: 'raf', timeout: 1000 });
  const interrupted = await state(page);
  await page.mouse.down();
  const paused = await state(page);
  assert(paused.error > 2, '测试必须在滑块尚未归位时按下当前选项');
  if (cancel) {
    await page.locator(groupSelector).evaluate(group => {
      const pointer = window.__showsSwitchProbe.lastPointer;
      if (!pointer) throw new Error('未捕获真实鼠标 pointerdown');
      group.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true, pointerType: 'mouse', button: 0, ...pointer,
      }));
    });
  }
  await page.mouse.up();
  const final = await settled(page, 2);
  await waitView(page, 2);
  return { interrupted, paused, final, input: cancel ? 'mouse-down / pointercancel / mouse-up' : 'mouse-down / mouse-up' };
}

async function rapidSwitches(page) {
  await open(page);
  const sequence = [2, 0, 2, 1, 0, 1];
  const transitions = [];
  for (const index of sequence) {
    await clickView(page, index);
    transitions.push(await state(page));
  }
  assert(transitions.some(item => item.error > 2), '必须覆盖尚在动画中再次切换的场景');
  const final = await settled(page, 1);
  assert.equal(await page.locator('.page-load-content .show-poster-tile').count(), shows.length, '最终必须呈现完整海报内容');
  assert.equal(await page.locator('.page-load-content .show-card-grid, .page-load-content .show-row-list').count(), 0, '最终内容必须与选中视图一致');
  assert.equal(await page.evaluate(() => localStorage.getItem('mooncell-shows-view')), 'posters', '存储的视图偏好必须与最终选择一致');
  return { sequence: sequence.map(index => views[index].value), transitions, final };
}

const cases = [
  { name: 'current-tap-resumes-interrupted-thumb', run: page => interruptTransition(page, false) },
  { name: 'pointercancel-resumes-interrupted-thumb', run: page => interruptTransition(page, true) },
  { name: 'rapid-switches-land-on-final-view', run: rapidSwitches },
];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await loadPlaywright().chromium.launch({ headless: true, channel: argument('--channel', 'msedge') });
  const results = [];
  try {
    for (const test of cases.filter(test => test.name.includes(argument('--case', '')))) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference' });
      const fixture = await installFixtures(context);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      await installProbe(page);
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error)));
      const started = performance.now();
      try {
        const details = await test.run(page);
        assert.deepEqual(pageErrors, [], '页面不得出现未处理脚本异常');
        assert.deepEqual(fixture.unmocked, [], '后端请求必须全部由夹具覆盖');
        results.push({ name: test.name, passed: true, durationMs: Math.round(performance.now() - started), details });
        console.log(`PASS ${test.name}`);
      } catch (error) {
        results.push({ name: test.name, passed: false, error: error.stack || String(error), state: await state(page).catch(() => null), pageErrors, unmocked: fixture.unmocked });
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
