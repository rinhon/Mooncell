#!/usr/bin/env node
/* RSS subscription regression against a local frontend preview.
 * node scripts\frontend-subscription-check.cjs --base-url http://127.0.0.1:4174
 * Optional: --case pending --channel msedge
 * All API responses use installFixtures or page-local route mocks; no backend is contacted.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  installFixtures,
  loadPlaywright,
  feeds,
} = require("./lib/frontend-fixture.cjs");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const baseUrl = new URL(argument("--base-url", "http://127.0.0.1:4174")).origin;
const caseFilter = argument("--case", "");
const output = path.resolve(
  __dirname,
  "..",
  ".cache",
  "frontend-subscription-check",
);
const cases = [];
const check = (name, run) => cases.push({ name, run });
const candidateA = {
  tmdb_id: 91001,
  media_type: "tv",
  title: "回归候选甲",
  original_title: "Candidate A",
  release_date: "2026-10-01",
  overview: "用于验证旧详情请求不覆盖新选择。",
  href: "https://www.themoviedb.org/tv/91001",
};
const candidateB = {
  tmdb_id: 91002,
  media_type: "movie",
  title: "回归候选乙",
  original_title: "Candidate B",
  release_date: "2026-10-02",
  overview: "当前应生效的电影候选。",
  href: "https://www.themoviedb.org/movie/91002",
};
// The mock objects match FeedInspection, TmdbCandidate, TmdbMetadata and Feed in src/lib/api.ts.
const metadata = (candidate) => ({
  ...candidate,
  genres: ["动画"],
  episode_count: candidate.media_type === "tv" ? 12 : 1,
  rating: 8.2,
  vote_count: 100,
});
const createdFeed = (input) => ({
  ...feeds[0],
  ...input,
  id: 9001,
  connection_status: "unknown",
  last_checked_at: undefined,
  last_error: undefined,
});
const json = (route, body) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function heldResponse(body) {
  const arrived = deferred();
  const released = deferred();
  return {
    arrived: arrived.promise,
    release: released.resolve,
    async handle(route) {
      const request = route.request();
      arrived.resolve(request);
      await released.promise;
      await json(
        route,
        typeof body === "function" ? body(request) : body,
      ).catch(() => {});
    },
  };
}

async function mockApi(page, handlers) {
  const requests = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname.replace("/api/v1", "");
    const key = `${request.method()} ${pathname}`;
    const handler = handlers[key];
    if (!handler) return route.fallback(); // The context fixture rejects unknown API paths locally.
    requests.push({
      key,
      body: request.postData() ? request.postDataJSON() : null,
    });
    await handler(route);
  });
  return requests;
}

async function openSubscription(page) {
  await page.goto(`${baseUrl}/feeds`, { waitUntil: "domcontentloaded" });
  await page.locator(".feed-card").first().waitFor();
  await page.getByRole("button", { name: "添加订阅", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加订阅", exact: true });
  await dialog.waitFor();
  return {
    dialog,
    url: dialog.locator('input[type="url"]'),
    name: dialog.getByPlaceholder("留空时由后端自动解析", { exact: true }),
    form: dialog
      .locator("form")
      .filter({ has: page.locator('input[type="url"]') }),
    save: dialog.getByRole("button", { name: "保存订阅", exact: true }),
    candidate: (title) => {
      const item = [candidateA, candidateB].find(
        (candidate) => candidate.title === title,
      );
      assert(item, `未知的回归候选：${title}`);
      return dialog
        .getByRole("group", { name: "匹配 TMDB 条目", exact: true })
        .getByRole("button", {
          name: `${item.title}，${item.media_type === "tv" ? "电视节目" : "电影"}，TMDB #${item.tmdb_id}`,
          exact: true,
        });
    },
  };
}

async function searchAndChoose(ui, candidate) {
  await ui.url.fill("https://feeds.example.test/regression.xml");
  await ui.name.fill("回归搜索关键词");
  await ui.dialog
    .getByRole("button", { name: "搜索 TMDB", exact: true })
    .click();
  await ui.candidate(candidate.title).click();
  await ui.dialog.getByText(new RegExp(`已刮削：${candidate.title}`)).waitFor();
  assert.equal(await ui.save.isEnabled(), true, "当前候选元数据就绪后才能保存");
}

async function finishResponse(page, response) {
  await response.finished();
  // A transport fence plus two frames lets fetch JSON and React callbacks run without fixed sleeps.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

check("rss-save-pending-close-and-submit", async ({ page }) => {
  const pending = heldResponse((request) =>
    createdFeed(request.postDataJSON()),
  );
  const requests = await mockApi(page, {
    "POST /feeds/prerequisites": (route) =>
      json(route, { message: "配置检查通过" }),
    "POST /tmdb/search": (route) => json(route, [candidateA]),
    "GET /tmdb/tv/91001": (route) => json(route, metadata(candidateA)),
    "POST /feeds": (route) => pending.handle(route),
  });
  try {
    const ui = await openSubscription(page);
    await searchAndChoose(ui, candidateA);
    // Dispatch in one browser task, before React can disable the form, to exercise the global pending guard.
    await ui.form.evaluate((form) => {
      for (let index = 0; index < 6; index++)
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await pending.arrived;
    const cancel = ui.dialog.getByRole("button", { name: "取消", exact: true });
    const magnetTab = ui.dialog.getByRole("tab", {
      name: "磁力合集",
      exact: true,
    });
    assert.equal(await cancel.isDisabled(), true, "保存期间取消按钮应禁用");
    assert.equal(
      await magnetTab.isDisabled(),
      true,
      "保存期间不得切换添加方式",
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await ui.dialog.isVisible(),
      true,
      "保存期间 Esc 不得卸载表单",
    );
    await cancel.evaluate((button) => button.click());
    await magnetTab.evaluate((button) => button.click());
    assert.equal(
      await ui.dialog
        .getByRole("tab", { name: "RSS 订阅", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    await ui.dialog.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(
      await ui.dialog.isVisible(),
      true,
      "保存期间关闭图标不得关闭弹窗",
    );
    await ui.form.evaluate((form) => {
      for (let index = 0; index < 3; index++)
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    assert.equal(
      requests.filter((item) => item.key === "POST /feeds").length,
      1,
      "连续提交应只产生一次创建请求",
    );
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/feeds" &&
        response.request().method() === "POST",
    );
    pending.release();
    await finishResponse(page, await response);
    await ui.dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "添加订阅", exact: true }).click();
    await ui.dialog.waitFor();
    assert.equal(await ui.url.inputValue(), "", "成功后重开应是新的空表单");
    assert.equal(
      await ui.dialog
        .getByRole("button", { name: "取消", exact: true })
        .isEnabled(),
      true,
    );
    await ui.dialog.getByRole("button", { name: "取消", exact: true }).click();
    await ui.dialog.waitFor({ state: "hidden" });
    assert.equal(
      requests.filter((item) => item.key === "POST /feeds").length,
      1,
    );
    return {
      submitEvents: 9,
      createRequests: 1,
      escapeBlocked: true,
      cancelBlocked: true,
      tabBlocked: true,
      successCloses: true,
      reopenClearsForm: true,
    };
  } finally {
    pending.release();
  }
});

check("rss-inspection-stale-url-response", async ({ page }) => {
  const urlA = "https://feeds.example.test/old-a.xml";
  const urlB = "https://feeds.example.test/current-b.xml";
  const pendingA = heldResponse({
    raw_title: "旧频道甲",
    name: "旧频道甲",
    kind: "mikan",
    entries: 99,
  });
  const requests = await mockApi(page, {
    "POST /feeds/prerequisites": (route) =>
      json(route, { message: "配置检查通过" }),
    "POST /feeds/inspect": (route) => {
      const input = route.request().postDataJSON();
      if (input.url === urlA) return pendingA.handle(route);
      assert.equal(input.url, urlB);
      return json(route, {
        raw_title: "当前频道乙",
        name: "当前频道乙",
        kind: "standard",
        entries: 7,
      });
    },
    "POST /tmdb/search": (route) => json(route, [candidateB]),
  });
  try {
    const ui = await openSubscription(page);
    await ui.url.fill(urlA);
    await ui.dialog
      .getByRole("button", { name: "解析 RSS", exact: true })
      .click();
    await pendingA.arrived;
    await ui.url.fill(urlB);
    await ui.dialog
      .getByRole("button", { name: "解析 RSS", exact: true })
      .click();
    await ui.candidate(candidateB.title).waitFor();
    assert.equal(await ui.name.inputValue(), "当前频道乙");
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/feeds/inspect" &&
        response.request().postDataJSON()?.url === urlA,
    );
    pendingA.release();
    await finishResponse(page, await response);
    assert.equal(await ui.url.inputValue(), urlB);
    assert.equal(
      await ui.name.inputValue(),
      "当前频道乙",
      "旧 RSS 解析不得覆盖新 URL 对应的名称",
    );
    assert.equal(
      await ui.dialog.getByRole("combobox").innerText(),
      "标准 RSS / Atom",
      "旧响应不得覆盖新来源类型",
    );
    assert.equal(await ui.candidate(candidateB.title).isVisible(), true);
    const searches = requests
      .filter((item) => item.key === "POST /tmdb/search")
      .map((item) => item.body.query);
    assert.deepEqual(
      searches,
      ["当前频道乙"],
      "旧解析结果不得再次启动旧名称搜索",
    );
    return {
      finalUrl: urlB,
      finalName: "当前频道乙",
      searches,
      staleInspectionIgnored: true,
    };
  } finally {
    pendingA.release();
  }
});

check("tmdb-detail-out-of-order-selected-identity", async ({ page }) => {
  const pendingA = heldResponse(metadata(candidateA));
  const requests = await mockApi(page, {
    "POST /feeds/prerequisites": (route) =>
      json(route, { message: "配置检查通过" }),
    "POST /tmdb/search": (route) => json(route, [candidateA, candidateB]),
    "GET /tmdb/tv/91001": (route) => pendingA.handle(route),
    "GET /tmdb/movie/91002": (route) => json(route, metadata(candidateB)),
    "POST /feeds": (route) =>
      json(route, createdFeed(route.request().postDataJSON())),
  });
  try {
    const ui = await openSubscription(page);
    await ui.url.fill("https://feeds.example.test/tmdb-race.xml");
    await ui.name.fill("乱序详情回归");
    await ui.dialog
      .getByRole("button", { name: "搜索 TMDB", exact: true })
      .click();
    await ui.candidate(candidateA.title).click();
    await pendingA.arrived;
    await ui.candidate(candidateB.title).click();
    await ui.dialog
      .getByText(new RegExp(`已刮削：${candidateB.title}`))
      .waitFor();
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/tmdb/tv/91001",
    );
    pendingA.release();
    await finishResponse(page, await response);
    assert.equal(
      await ui.candidate(candidateB.title).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await ui.candidate(candidateA.title).getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      await ui.dialog
        .getByText(new RegExp(`已刮削：${candidateB.title}`))
        .isVisible(),
      true,
    );
    assert.equal(
      await ui.dialog
        .getByText(new RegExp(`已刮削：${candidateA.title}`))
        .count(),
      0,
      "迟到的甲详情不得替换当前乙元数据",
    );
    assert.equal(await ui.save.isEnabled(), true);
    await ui.save.click();
    await ui.dialog.waitFor({ state: "hidden" });
    const creates = requests.filter((item) => item.key === "POST /feeds");
    assert.equal(creates.length, 1);
    assert.deepEqual(
      creates[0].body.tmdb,
      { tmdb_id: candidateB.tmdb_id, media_type: candidateB.media_type },
      "提交的 ID 和媒体类型必须与当前候选、已显示元数据一致",
    );
    return {
      responseOrder: ["B", "A"],
      selected: candidateB.title,
      submittedTmdb: creates[0].body.tmdb,
      createRequests: creates.length,
    };
  } finally {
    pendingA.release();
  }
});

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    channel: argument("--channel", process.env.PLAYWRIGHT_CHANNEL || "msedge"),
  });
  const results = [];
  try {
    for (const test of cases.filter((test) => test.name.includes(caseFilter))) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        timezoneId: "Asia/Shanghai",
        reducedMotion: "reduce",
      });
      const fixture = await installFixtures(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const started = performance.now();
      try {
        const details = await test.run({ page });
        assert.deepEqual(pageErrors, [], "页面出现未处理的脚本异常");
        assert.deepEqual(fixture.unmocked, [], "回归测试缺少本地接口 mock");
        results.push({
          name: test.name,
          passed: true,
          durationMs: Math.round(performance.now() - started),
          details,
        });
        console.log(`PASS ${test.name}`);
      } catch (error) {
        const screenshot = path.join(output, `${test.name}-failure.png`);
        await page
          .screenshot({ path: screenshot, timeout: 5000 })
          .catch(() => {});
        results.push({
          name: test.name,
          passed: false,
          durationMs: Math.round(performance.now() - started),
          error: error.stack || String(error),
          pageErrors,
          unmocked: fixture.unmocked,
          screenshot,
        });
        console.error(`FAIL ${test.name}: ${error.message}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert(results.length > 0, `没有匹配的测试：${caseFilter}`);
  const report = {
    baseUrl,
    passed: results.every((result) => result.passed),
    checkedAt: new Date().toISOString(),
    results,
  };
  const reportPath = path.join(output, "result.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `${results.filter((result) => result.passed).length}/${results.length} 项通过；报告：${reportPath}`,
  );
  if (!report.passed) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
