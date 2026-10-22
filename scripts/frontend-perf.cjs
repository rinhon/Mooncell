#!/usr/bin/env node
/* Local synthetic benchmark, not a substitute for a physical iGPU DevTools run.
 * node scripts\frontend-perf.cjs --stage p0 --base-url http://127.0.0.1:4173
 * Optional: --widths 1920,3840 --theme forest --no-trace --channel msedge
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { installFixtures, loadPlaywright } = require('./lib/frontend-fixture.cjs');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  args[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}
const stage = String(args.stage || 'current');
if (!/^[\w-]+$/.test(stage)) throw new Error('stage 只能包含字母、数字、下划线和短横线');
const output = path.resolve(__dirname, '..', '.cache', 'perf');
fs.mkdirSync(output, { recursive: true });
const { chromium } = loadPlaywright();

(async () => {
  const browser = await chromium.launch({ headless: true, channel: String(args.channel || 'msedge') });
  let gpu;
  try { const session = await browser.newBrowserCDPSession(); gpu = (await session.send('SystemInfo.getInfo')).gpu; await session.detach(); } catch (error) { gpu = { unavailable: String(error) }; }
  const report = { stage, baseURL: String(args['base-url'] || 'http://127.0.0.1:5173'), startedAt: new Date().toISOString(), environment: { browser: await browser.version(), headless: true, os: process.platform, gpu, gpuUtilization: null, limitations: '本机 Edge 无头浏览器与模拟接口的合成测量。视口尺寸为 CSS 像素、DPR=1。GPU 利用率无法由可靠接口获取，未测量；不是物理集显 1080p/4K 的验收成绩。FPS 来自页面 requestAnimationFrame，不代表显示器呈现帧率。' }, fixtureShows: 36, scenarios: [] };
  try {
    for (const width of String(args.widths || '1920,3840').split(',').map(Number)) {
      const height = width === 3840 ? 2160 : Math.round(width * 9 / 16);
      for (const scenario of [{ name: 'shows-scroll', route: '/shows', duration: 5000 }, { name: 'calendar-switch', route: '/calendar', duration: 5000 }, { name: 'home-idle', route: '/', duration: 10000 }]) {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
        const fixture = await installFixtures(context, { theme: String(args.theme || 'forest') });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        let session, traceFile = null, traceError = null;
        const events = [];
        try {
          await page.goto(new URL(scenario.route, report.baseURL).href, { waitUntil: 'domcontentloaded' });
          await page.locator('.top-navigation').waitFor();
          await page.locator(scenario.name === 'shows-scroll' ? '.show-card-grid > *' : scenario.name === 'calendar-switch' ? '.calendar-item' : '.dashboard-stat-strip').first().waitFor();
          await page.waitForTimeout(1200);
          if (!args['no-trace']) {
            try {
              session = await context.newCDPSession(page);
              session.on('Tracing.dataCollected', event => events.push(...event.value));
              await session.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,toplevel,gpu', options: 'record-as-much-as-possible' });
            } catch (error) { traceError = String(error); }
          }
          const metrics = await page.evaluate(async ({ name, duration }) => {
            const longTasks = [], intervals = [];
            let observer;
            try { observer = new PerformanceObserver(list => { for (const item of list.getEntries()) longTasks.push({ startTime: item.startTime, duration: item.duration }); }); observer.observe({ type: 'longtask', buffered: false }); } catch {}
            const start = performance.now();
            let previous = start, frames = 0, switches = 0, lastSwitch = start;
            const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
            await new Promise(resolve => {
              function tick(now) {
                intervals.push(now - previous); previous = now; frames++;
                const elapsed = now - start;
                if (name === 'shows-scroll') scrollTo(0, maxScroll * Math.min(1, elapsed / duration));
                if (name === 'calendar-switch' && now - lastSwitch > 650) {
                  const tabs = [...document.querySelectorAll('.calendar-week-tab[role="tab"]')].filter(node => !node.hidden);
                  const index = tabs.findIndex(node => node.getAttribute('data-state') === 'active');
                  tabs[(index + 1) % tabs.length]?.click(); switches++; lastSwitch = now;
                }
                if (elapsed >= duration) resolve(); else requestAnimationFrame(tick);
              }
              requestAnimationFrame(tick);
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            observer?.disconnect();
            for (let i = longTasks.length - 1; i >= 0; i--) if (longTasks[i].startTime < start || longTasks[i].startTime >= previous) longTasks.splice(i, 1);
            const elapsed = previous - start;
            const sorted = intervals.slice(1).sort((a, b) => a - b);
            return { durationMs: +elapsed.toFixed(2), requestedDurationMs: duration, frameCount: frames, rafFps: +(frames * 1000 / elapsed).toFixed(2), frameIntervalP50Ms: +sorted[Math.floor(sorted.length * .5)].toFixed(2), frameIntervalP95Ms: +sorted[Math.floor(sorted.length * .95)].toFixed(2), framesOver25Ms: intervals.filter(value => value > 25).length, longTaskCount: longTasks.length, longTaskTotalMs: +longTasks.reduce((sum, value) => sum + value.duration, 0).toFixed(2), longestTaskMs: Math.max(0, ...longTasks.map(value => value.duration)), longTasks, maxScroll, finalScrollY: scrollY, calendarSwitches: switches, showCardCount: document.querySelectorAll('.show-card-grid > *').length };
          }, scenario);
          if (session && !traceError) {
            try {
              let traceTimeout;
              const done = new Promise((resolve, reject) => {
                session.once('Tracing.tracingComplete', resolve);
                traceTimeout = setTimeout(() => reject(new Error('等待 CDP trace 完成超时（10 秒）')), 10000);
              });
              try { await session.send('Tracing.end'); await done; } finally { clearTimeout(traceTimeout); }
              traceFile = `${stage}-${width}-${scenario.name}-trace.json.gz`;
              fs.writeFileSync(path.join(output, traceFile), zlib.gzipSync(JSON.stringify({ traceEvents: events, metadata: { browser: report.environment.browser, scenario: scenario.name, width, height } })));
            } catch (error) { traceError = String(error); }
          }
          const result = { name: scenario.name, viewport: { width, height }, ...metrics, traceFile, traceError, errors, unmocked: fixture.unmocked };
          report.scenarios.push(result);
          console.log(JSON.stringify({ name: scenario.name, width, rafFps: metrics.rafFps, longTaskCount: metrics.longTaskCount, longestTaskMs: metrics.longestTaskMs, traceFile }));
        } catch (error) { report.scenarios.push({ name: scenario.name, viewport: { width, height }, error: String(error), errors }); console.error(error.message); }
        finally { if (session) await session.detach().catch(() => {}); await context.close(); fs.writeFileSync(path.join(output, `${stage}-render.json`), JSON.stringify(report, null, 2)); }
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, `${stage}-render.json`), JSON.stringify(report, null, 2));
    await browser.close();
  }
  console.log(path.join(output, `${stage}-render.json`));
  if (report.scenarios.some(item => item.error || item.errors.length || item.unmocked?.length)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
