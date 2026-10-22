const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/player/hls-engine.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function snapshot(extra = {}) { return { id: "a", generation: 1, duration: 1000, source_anchor: 100, playlist_url: "/stream", cached_ranges: [[100, 103]], segments: [{ sequence: 10, source_start: 100, duration: 3 }], ...extra }; }
function setup(initial = snapshot()) {
  let hls, ready = 0; const errors = [];
  class FakeHls {
    static isSupported() { return true; }
    constructor(config) { this.config = config; this.events = new Map(); this.recovered = 0; this.stopped = 0; this.destroyed = 0; hls = this; }
    on(name, handler) { this.events.set(name, handler); }
    emit(name, data) { this.events.get(name)?.(name, data); }
    attachMedia() {} loadSource() {}
    recoverMediaError() { this.recovered++; }
    stopLoad() { this.stopped++; }
    destroy() { this.destroyed++; }
  }
  const video = { currentTime: 8, paused: false, pauses: 0, loaded: 0, pause() { this.paused = true; this.pauses++; }, load() { this.loaded++; }, removeAttribute() {}, buffered: { length: 1, start() { return 5; }, end() { return 35; } } };
  const sandbox = { exports: {}, require(name) {
    if (name === "hls.js") return { __esModule: true, default: FakeHls, Events: { FRAG_BUFFERED: "buffered", ERROR: "error" }, ErrorTypes: { MEDIA_ERROR: "media" } };
    if (name === "./types") return { sourceTime(media, source, anchor, duration) { return Math.min(duration, Math.max(0, source + media - anchor)); } };
    throw new Error(name);
  } };
  vm.runInNewContext(compiled, sandbox);
  const engine = new sandbox.exports.HlsEngine(video, initial, (...args) => errors.push(args), () => ready++);
  return { engine, hls, video, errors, get ready() { return ready; }, frag(sequence, pts) { hls.emit("buffered", { frag: { sn: sequence, start: 999, elementaryStreams: { video: { startPTS: pts } } } }); } };
}

test("disables the latency controller, catch-up rate and edge seeks explicitly", () => {
  const env = setup();
  assert.equal(env.hls.config.lowLatencyMode, false);
  assert.equal(env.hls.config.liveSyncDuration, Number.MAX_SAFE_INTEGER);
  assert.equal(env.hls.config.liveMaxLatencyDuration, Infinity);
  assert.equal(env.hls.config.maxLiveSyncPlaybackRate, 1);
  assert.equal(Object.hasOwn(env.hls.config, "latencyController"), true);
  assert.equal(env.hls.config.latencyController, undefined);
  env.engine.destroy();
});

test("uses actual video PTS with matching source segment, retaining the anchor as the manifest slides", () => {
  const env = setup();
  env.frag(10, 5.25);
  assert.equal(env.ready, 1);
  assert.equal(env.engine.getSourceTime(), 102.75);
  env.engine.update(snapshot({ source_anchor: 160, segments: [{ sequence: 30, source_start: 160, duration: 3 }] }));
  env.frag(30, 65.25);
  assert.equal(env.ready, 1);
  assert.equal(env.engine.getSourceTime(), 102.75);
  assert.equal(env.engine.seek(110), true);
  assert.equal(env.video.currentTime, 15.25);
  assert.equal(env.engine.seek(300), false);
  env.engine.destroy();
});

test("reconciles a buffered fragment whose source metadata arrives in a later snapshot", () => {
  const env = setup(snapshot({ segments: [] }));
  env.frag(10, 5.25);
  assert.equal(env.ready, 0);
  env.engine.update(snapshot());
  assert.equal(env.ready, 1);
  assert.equal(env.engine.getSourceTime(), 102.75);
  env.engine.update(snapshot({ id: "other", source_anchor: 900 }));
  env.engine.update(snapshot({ generation: 2, source_anchor: 900 }));
  assert.equal(env.engine.getSourceTime(), 102.75);
  env.engine.destroy();
});

test("auth expiry stops loading and ignores subsequent recovery events", () => {
  const env = setup();
  const expired = { response: { code: 401 }, fatal: false };
  env.hls.emit("error", expired);
  assert.equal(expired.fatal, true);
  assert.equal(env.hls.stopped, 1);
  assert.equal(env.video.paused, true);
  assert.equal(env.errors[0][1], true);
  env.hls.emit("error", { type: "media", fatal: true });
  env.frag(10, 5.25);
  assert.equal(env.hls.recovered, 0);
  assert.equal(env.ready, 0);
  env.engine.destroy(); env.engine.destroy();
  assert.equal(env.hls.destroyed, 1);
});

test("media errors have a finite recovery budget", () => {
  const env = setup();
  for (let i = 0; i < 4; i++) env.hls.emit("error", { type: "media", fatal: true });
  assert.equal(env.hls.recovered, 2);
  assert.equal(env.hls.stopped, 2);
  env.engine.destroy();
});

test("server-cached but unbuffered seeks use the existing source-to-media anchor", () => {
  const env = setup(snapshot({ cached_ranges: [[100, 190]] }));
  env.frag(10, 5.25);
  env.video.buffered = { length: 0, start() { throw new Error("empty buffer"); }, end() { throw new Error("empty buffer"); } };
  env.video.paused = true;
  assert.equal(env.engine.seek(160), true);
  assert.equal(env.video.currentTime, 65.25);
  assert.equal(env.engine.getSourceTime(), 160);
  assert.equal(env.video.paused, true);
  assert.equal(env.ready, 1);
  assert.equal(env.hls.stopped, 0);
  env.engine.destroy();
});

test("cache limits and missing anchors leave external seeks to generation recreation", () => {
  const env = setup(snapshot({ cached_ranges: [[100, 190]] }));
  assert.equal(env.engine.seek(160), false);
  env.frag(10, 5.25);
  const original = env.video.currentTime;
  assert.equal(env.engine.seek(190), false);
  assert.equal(env.engine.seek(300), false);
  assert.equal(env.engine.seek(NaN), false);
  assert.equal(env.engine.seek(Infinity), false);
  assert.equal(env.video.currentTime, original);
  // Browser-buffered history remains usable even after leaving server cache.
  env.engine.update(snapshot({ cached_ranges: [[150, 190]] }));
  assert.equal(env.engine.seek(110), true);
  assert.equal(env.video.currentTime, 15.25);
  env.engine.destroy();
  assert.equal(env.engine.seek(160), false);
});
