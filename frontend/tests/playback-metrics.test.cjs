const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/player/playback-metrics.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup() {
  let now = 0;
  const window = {}, sandbox = { exports: {}, window, performance: { now: () => now } };
  vm.runInNewContext(compiled, sandbox);
  const element = { dataset: { sessionId: "session-a" } };
  const metrics = sandbox.exports;
  const unbind = metrics.bindPlaybackMetrics(element, "media-a");
  const session = { id: "session-a", generation: 1 };
  return { metrics, element, session, window, unbind, advance(value) { now += value; } };
}

test("latest DOM metrics expose only the completed target frame and clear it at the next seek", () => {
  const env = setup(), data = env.element.dataset;
  const first = env.metrics.beginSeekMetric("media-a", env.session, 90);
  env.metrics.setSeekPath(first, "buffered");
  assert.equal(data.lastSeekStatus, "pending");
  assert.equal(data.lastSeekPath, "buffered");
  assert.equal(data.lastSeekFrameMs, undefined);
  env.advance(12.25);
  env.metrics.finishSeekMetric(first, 90.02, "video-frame");
  assert.equal(data.lastSeekId, String(first));
  assert.equal(data.lastSeekStatus, "completed");
  assert.equal(data.lastSeekFrameMs, "12.250");
  assert.equal(data.lastSeekSourceTime, "90.02");
  assert.equal(data.lastSeekEvidence, "video-frame");
  assert.equal(env.window.__mooncellPlaybackMetrics.read()[0].firstFrameMs, 12.25);
  const second = env.metrics.beginSeekMetric("media-a", env.session, 120);
  assert.equal(data.lastSeekId, String(second));
  assert.equal(data.lastSeekStatus, "pending");
  assert.equal(data.lastSeekFrameMs, undefined);
  assert.equal(data.lastSeekSourceTime, undefined);
  assert.equal(data.lastSeekEvidence, undefined);
  env.metrics.cancelSeekMetric(second, "failed");
  assert.equal(data.lastSeekStatus, "failed");
});

test("superseded or foreign media/session measurements cannot replace the current player's result", () => {
  const env = setup(), data = env.element.dataset;
  const first = env.metrics.beginSeekMetric("media-a", env.session, 90);
  const second = env.metrics.beginSeekMetric("media-a", env.session, 120);
  env.metrics.cancelSeekMetric(first);
  env.metrics.finishSeekMetric(first, 90, "video-frame");
  assert.equal(data.lastSeekId, String(second));
  assert.equal(data.lastSeekStatus, "pending");
  env.metrics.finishSeekMetric(second, 120, "video-frame");
  env.metrics.beginSeekMetric("other-media", env.session, 150);
  env.metrics.beginSeekMetric("media-a", { id: "old-session", generation: 1 }, 180);
  assert.equal(data.lastSeekId, String(second));
  assert.equal(data.lastSeekStatus, "completed");
  data.sessionId = "new-session";
  env.metrics.recordSeekResponse(second, { ...env.session, timings: {} });
  assert.equal(data.lastSeekId, String(second));
  env.unbind();
  const third = env.metrics.beginSeekMetric("media-a", { id: "new-session", generation: 1 }, 200);
  env.metrics.finishSeekMetric(third, 200, "video-frame");
  assert.equal(data.lastSeekId, String(second), "An unmounted player receives no further writes");
});
