const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

// Run the real component without a DOM renderer; native refs are attached before
// effects, while playback transport and HLS signals remain under test control.
const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/components/player/player.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const metricsCompiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/player/playback-metrics.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function session(status = "ready", generation = 1) {
  return {
    id: "session-a", generation, status, playlist_url: status === "preparing" ? null : "/playlist.m3u8",
    quality: 720, audio_track: null, source_anchor: 0, duration: 600, error: null, segments: [],
  };
}

function setup(options = {}) {
  const steps = [], engines = [], nativeEngines = [], restarts = [], seeks = [], seekRequests = [], playRequests = [], fallbacks = [], timers = new Map(), videoFrames = new Map();
  let active, timerId = 0, playCalls = 0, frameId = 0, now = 0;
  const metricsSandbox = { exports: {}, window: {}, performance: { now: () => now } };
  vm.runInNewContext(metricsCompiled, metricsSandbox);
  const element = () => ({ dataset: {}, focus() {}, querySelector() { return null; }, setAttribute() {} });
  const video = Object.assign(element(), {
    readyState: 0, currentTime: 0, seeking: false, paused: true, ended: false, volume: 1, playbackRate: 1,
    requestVideoFrameCallback(callback) { const id = ++frameId; videoFrames.set(id, callback); return id; },
    cancelVideoFrameCallback(id) { videoFrames.delete(id); },
    play() {
      playCalls++;
      if (options.deferPlay) return new Promise((resolve, reject) => playRequests.push({ resolve, reject }));
      return options.rejectAutoplay ? Promise.reject(new Error("Autoplay blocked")) : Promise.resolve();
    },
    pause() { this.paused = true; },
  });
  if (options.withoutVideoFrames) delete video.requestVideoFrameCallback;
  const native = { div: element(), video, canvas: element() };
  const playback = {
    session: null, error: null, locating: false,
    clock: { current: { position: 0, paused: true, playbackRate: 1 } },
    setError(value) { playback.error = value; runner.dirty = true; },
    restart(position) { restarts.push(position); playback.session = null; playback.error = null; runner.dirty = true; },
    seek(position, settings) {
      seeks.push(position);
      if (!options.deferSeeks) return Promise.resolve(playback.session);
      let resolve;
      const promise = new Promise((yes) => { resolve = yes; });
      seekRequests.push({ position, settings, resolve });
      return promise;
    },
    heartbeat() {}, save() {}, options() {},
    fallback() {
      let resolve;
      const promise = new Promise((yes) => { resolve = yes; });
      fallbacks.push({ resolve });
      return promise;
    },
  };
  const depsEqual = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    useState(initial) {
      const owner = active, index = owner.cursor++;
      if (!owner.slots[index]) owner.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      const setter = (next) => {
        const slot = owner.slots[index], value = typeof next === "function" ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; owner.dirty = true; }
      };
      return [owner.slots[index].value, setter];
    },
    useRef(initial) { const owner = active, index = owner.cursor++; return owner.slots[index] ??= { current: initial }; },
    useCallback(callback, deps) {
      const owner = active, index = owner.cursor++, old = owner.slots[index];
      if (!old || !depsEqual(old.deps, deps)) owner.slots[index] = { callback, deps };
      return owner.slots[index].callback;
    },
    useEffect(create, deps) {
      const owner = active, index = owner.cursor++, old = owner.slots[index];
      if (!old || !depsEqual(old.deps, deps)) owner.effects.push(() => {
        old?.cleanup?.();
        const slot = { create, deps };
        owner.slots[index] = slot;
        slot.cleanup = create();
      });
    },
  };
  class HlsEngine {
    constructor(element, value, onError, onReady) {
      if (options.hlsInitializationError) throw new Error("HLS initialization failed");
      this.video = element; this.session = value; this.fail = onError; this.ready = onReady; this.destroyed = false; this.seekCalls = 0;
      engines.push(this);
    }
    update(value) { this.session = value; }
    seek(position) { this.seekCalls++; const path = options.seekPath ?? "miss"; if (path !== "miss") this.video.currentTime = position - this.session.source_anchor; return path; }
    alignToSource(position) { this.video.currentTime = position - this.session.source_anchor; return true; }
    getSourceTime(mediaTime = this.video.currentTime) { return this.session.source_anchor + mediaTime; }
    getBufferedAhead() { return options.bufferedAhead ?? 30; }
    destroy() { this.destroyed = true; }
  }
  class NativeEngine extends HlsEngine {
    constructor(...args) { super(...args); nativeEngines.push(this); }
  }
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const document = Object.assign(new EventTarget(), { fullscreenElement: null, activeElement: null });
  const modules = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-router-dom": { Link: "Link" },
    "lucide-react": { ArrowLeft: "ArrowLeft", LoaderCircle: "LoaderCircle", Play: "Play", TriangleAlert: "TriangleAlert" },
    "@/hooks/use-playback-session": { usePlaybackSession: () => playback },
    "@/lib/player/types": { clampTime: (value, duration) => Math.min(Math.max(0, value), Math.max(0, duration)) },
    "@/lib/player/hls-engine": { HlsEngine },
    "@/lib/player/native-engine": { NativeEngine },
    "@/lib/player/playback-metrics": metricsSandbox.exports,
    "@/lib/player/anime4k-renderer": { createAnime4kRenderer: () => ({ setMode() { return Promise.resolve(); }, renderCurrentFrame() {}, destroy() {} }) },
    "./player-controls": { PlayerControls: "PlayerControls" },
    "./player-episodes": { PlayerEpisodes: "PlayerEpisodes" },
    "./subtitle-overlay": { SubtitleOverlay: "SubtitleOverlay" },
  };
  const sandbox = {
    exports: {}, require(name) { assert.ok(modules[name], `Unexpected import: ${name}`); return modules[name]; },
    document, HTMLElement: class {}, localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }, Error, performance: { now: () => now },
  };
  vm.runInNewContext(compiled, sandbox, { filename: "player.js" });
  function visit(node, callback) {
    if (Array.isArray(node)) return node.forEach((child) => visit(child, callback));
    if (!node || typeof node !== "object") return;
    callback(node);
    visit(node.props?.children, callback);
  }
  const props = {
    mediaId: "a",
    info: { media_id: "a", duration: 600, frame_rate: options.frameRate, supported: true, progress: null, qualities: [720], audio_tracks: [], subtitle_tracks: [] },
    showTitle: "测试番剧", episodeTitle: "第一集", backTo: "/shows/a", libraryLoading: false,
    onRetryLibrary() {}, onSelectEpisode() {}, fullscreenTarget: { current: null }, autoPlay: true,
    savedPreferences: { volume: 0.8, rate: 1 }, onPreferencesChange() {}, onStartupStepChange: (step) => steps.push(step),
  };
  const runner = {
    slots: [], effects: [], dirty: false, tree: null,
    render() {
      this.cursor = 0; this.effects = []; this.dirty = false; active = this;
      this.tree = sandbox.exports.Player(props);
      active = null;
      visit(this.tree, (node) => { if (node.props.ref && native[node.type]) node.props.ref.current = native[node.type]; });
      this.effects.forEach((effect) => effect());
    },
    unmount() { this.slots.forEach((slot) => slot?.cleanup?.()); },
  };
  runner.render();
  return {
    steps, engines, nativeEngines, restarts, seeks, seekRequests, playRequests, fallbacks, playback, video, runner,
    metrics: () => metricsSandbox.exports.readPlaybackMetrics(),
    advance(milliseconds) { now += milliseconds; },
    frame(mediaTime) {
      video.currentTime = mediaTime;
      const current = [...videoFrames.values()]; videoFrames.clear();
      current.forEach((callback) => callback(now, { mediaTime }));
    },
    get playCalls() { return playCalls; },
    node(predicate) { let found; visit(runner.tree, (node) => { if (!found && predicate(node)) found = node; }); assert.ok(found, "Expected rendered node"); return found; },
    videoEvent(name) { this.node((node) => node.type === "video").props[name](); },
    setSession(value) { playback.session = value; runner.render(); },
    async settle() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (runner.dirty) runner.render(); } },
  };
}

test("startup follows session creation, preparation and first playable HLS frame", async () => {
  const env = setup();
  await env.settle();
  assert.deepEqual(env.steps, [1]);
  env.setSession(session("preparing")); await env.settle();
  assert.deepEqual(env.steps, [1, 2]);
  assert.equal(env.engines.length, 0);
  env.setSession(session()); await env.settle();
  assert.deepEqual(env.steps, [1, 2, 3]);
  assert.equal(env.engines.length, 1);
  env.video.readyState = 2;
  env.engines[0].ready(); await env.settle();
  assert.deepEqual(env.steps, [1, 2, 3, null]);
  assert.equal(env.playCalls, 1);
  env.runner.unmount();
});

for (const event of ["onLoadedData", "onCanPlay"]) {
  test(`HLS readiness waits for usable video data via ${event}`, async () => {
    const env = setup();
    env.setSession(session()); await env.settle();
    env.video.readyState = 1;
    env.engines[0].ready(); await env.settle();
    env.videoEvent(event); await env.settle();
    assert.deepEqual(env.steps, [1, 3]);
    env.video.readyState = 2;
    env.videoEvent(event); await env.settle();
    assert.deepEqual(env.steps, [1, 3, null]);
    env.runner.unmount();
  });
}

test("video data alone cannot dismiss startup before the first HLS segment is ready", async () => {
  const env = setup();
  env.setSession(session()); await env.settle();
  env.video.readyState = 2;
  env.videoEvent("onLoadedData"); env.videoEvent("onCanPlay"); await env.settle();
  assert.deepEqual(env.steps, [1, 3]);
  env.engines[0].ready(); await env.settle();
  assert.deepEqual(env.steps, [1, 3, null]);
  env.runner.unmount();
});

test("HLS failure dismisses startup and retry starts a fresh loading sequence", async () => {
  const env = setup();
  env.setSession(session()); await env.settle();
  env.engines[0].fail("视频加载失败，请重试播放。"); await env.settle();
  assert.deepEqual(env.steps, [1, 3, null]);
  assert.equal(env.node((node) => node.props.role === "alert").props.className, "player-message");
  env.node((node) => node.props.className === "player-action-button").props.onClick(); await env.settle();
  assert.deepEqual(env.restarts, [0]);
  assert.deepEqual(env.steps, [1, 3, null, 1]);
  env.setSession(session("preparing", 2)); await env.settle();
  env.setSession(session("ready", 2)); await env.settle();
  assert.deepEqual(env.steps, [1, 3, null, 1, 2, 3]);
  env.video.readyState = 2;
  env.videoEvent("onCanPlay"); await env.settle();
  assert.equal(env.steps.at(-1), 3, "Retry must wait for its own HLS readiness");
  env.engines.at(-1).ready(); await env.settle();
  assert.equal(env.steps.at(-1), null);
  env.runner.unmount();
});

for (const status of ["failed", "closed"]) {
  test(`${status} session exits startup so the playback error remains accessible`, async () => {
    const env = setup();
    env.setSession(session(status)); await env.settle();
    assert.deepEqual(env.steps, [1, null]);
    env.node((node) => node.props.role === "alert");
    env.node((node) => node.props.className === "player-action-button");
    env.runner.unmount();
  });
}

test("session request and HLS initialization errors dismiss startup", async () => {
  const env = setup();
  env.playback.setError("播放请求失败"); await env.settle();
  assert.deepEqual(env.steps, [1, null]);
  env.runner.unmount();
  const invalidHls = setup({ hlsInitializationError: true });
  invalidHls.setSession(session()); await invalidHls.settle();
  assert.deepEqual(invalidHls.steps, [1, 3, null]);
  invalidHls.node((node) => node.props.role === "alert");
  invalidHls.runner.unmount();
});

test("later buffering and server seeks keep startup dismissed and use the local status", async () => {
  const env = setup();
  env.setSession(session()); env.video.readyState = 2;
  env.engines[0].ready(); await env.settle();
  const completedSteps = [...env.steps];
  env.videoEvent("onWaiting"); await env.settle();
  env.node((node) => node.props.className === "player-status");
  env.node((node) => node.type === "PlayerControls").props.onSeek(90);
  env.playback.locating = true;
  env.setSession(session("preparing", 2)); await env.settle();
  assert.deepEqual(env.seeks, [90]);
  env.node((node) => node.props.className === "player-status");
  env.setSession(session("ready", 2)); await env.settle();
  env.engines.at(-1).ready(); env.videoEvent("onCanPlay"); await env.settle();
  assert.deepEqual(env.steps, completedSteps);
  assert.equal(env.steps.at(-1), null);
  env.runner.unmount();
});

test("retry after a completed startup resets completion and requires the new stream", async () => {
  const env = setup();
  env.setSession(session()); env.video.readyState = 2;
  env.engines[0].ready(); await env.settle();
  env.playback.setError("连接中断"); await env.settle();
  env.node((node) => node.props.className === "player-action-button").props.onClick(); await env.settle();
  assert.equal(env.steps.at(-1), 1);
  env.setSession(session("ready", 2)); await env.settle();
  env.videoEvent("onLoadedData"); await env.settle();
  assert.equal(env.steps.at(-1), 3);
  env.engines.at(-1).ready(); await env.settle();
  assert.equal(env.steps.at(-1), null);
  env.runner.unmount();
});

test("autoplay rejection still exits startup and leaves the manual playback notice", async () => {
  const env = setup({ rejectAutoplay: true });
  env.setSession(session()); env.video.readyState = 2;
  env.engines[0].ready(); await env.settle();
  assert.deepEqual(env.steps, [1, 3, null]);
  assert.equal(env.playCalls, 1);
  assert.equal(env.node((node) => node.props.className === "player-notice").props.children, "视频已就绪，点击播放开始。");
  env.node((node) => node.props.className === "player-center-play");
  env.runner.unmount();
});

async function readyPlayer(env, value = session()) {
  env.setSession(value);
  env.video.readyState = 2;
  env.engines.at(-1).ready();
  await env.settle();
}

test("buffered seek presents its own frame before the server acknowledgement without recreating HLS", async () => {
  const env = setup({ seekPath: "buffered", deferSeeks: true });
  await readyPlayer(env);
  env.node((node) => node.type === "PlayerControls").props.onSeek(90);
  await env.settle();
  assert.equal(env.seekRequests[0].settings.clientBuffered, true);
  assert.equal(env.node((node) => node.type === "PlayerControls").props.buffering, false);
  env.video.currentTime = 4;
  env.videoEvent("onTimeUpdate");
  env.frame(4); await env.settle();
  assert.equal(env.playback.clock.current.position, 90, "Old timeupdate cannot move the requested source clock");
  assert.equal(env.metrics()[0].status, "pending");
  env.advance(12); env.frame(90); await env.settle();
  assert.equal(env.metrics()[0].status, "completed");
  assert.equal(env.metrics()[0].firstFrameMs, 12);
  assert.equal(env.metrics()[0].frameEvidence, "video-frame");
  assert.equal(env.metrics()[0].frameSourceTime, 90);
  assert.equal(env.metrics()[0].controlResponseMs, undefined);
  env.advance(30);
  env.seekRequests[0].resolve({ ...session(), seek_disposition: "buffered", requires_reload: false });
  await env.settle();
  assert.equal(env.metrics()[0].controlResponseMs, 42);
  assert.equal(env.metrics()[0].firstFrameMs, 12);
  assert.equal(env.engines.length, 1);
  env.runner.unmount();
});

test("server-cache seek requests an ordinary clock update and keeps buffering until the target frame", async () => {
  const env = setup({ seekPath: "server-cache", deferSeeks: true });
  await readyPlayer(env);
  env.node((node) => node.type === "PlayerControls").props.onSeek(90); await env.settle();
  assert.equal(env.seekRequests[0].settings.clientBuffered, false);
  assert.equal(env.node((node) => node.type === "PlayerControls").props.buffering, true);
  env.seekRequests[0].resolve({ ...session(), seek_disposition: "server-cache", requires_reload: false });
  await env.settle();
  assert.equal(env.metrics()[0].status, "pending", "A control response is not a presented frame");
  env.advance(80); env.frame(90); await env.settle();
  assert.equal(env.metrics()[0].path, "server-cache");
  assert.equal(env.metrics()[0].status, "completed");
  assert.equal(env.node((node) => node.type === "PlayerControls").props.buffering, false);
  assert.equal(env.engines.length, 1);
  env.runner.unmount();
});

test("cold seek ignores old frames and completes only from the acknowledged generation and source timeline", async () => {
  const env = setup({ deferSeeks: true });
  await readyPlayer(env);
  env.node((node) => node.type === "PlayerControls").props.onSeek(90); await env.settle();
  env.video.currentTime = 4;
  env.videoEvent("onTimeUpdate"); env.frame(90); await env.settle();
  assert.equal(env.playback.clock.current.position, 90);
  assert.equal(env.metrics()[0].status, "pending");
  const preparing = { ...session("preparing", 2), source_anchor: 90, requires_reload: true };
  env.seekRequests[0].resolve(preparing); env.setSession(preparing); await env.settle();
  env.engines[0].ready(); await env.settle();
  assert.equal(env.metrics()[0].status, "pending", "The old HLS callback cannot complete a new seek");
  env.setSession({ ...session("ready", 2), source_anchor: 90 });
  env.video.currentTime = 0; env.engines.at(-1).ready();
  env.advance(45); env.frame(0); await env.settle();
  assert.equal(env.metrics()[0].generation, 2);
  assert.equal(env.metrics()[0].status, "completed");
  assert.equal(env.metrics()[0].frameSourceTime, 90);
  env.runner.unmount();
});

test("rapid seeks supersede prior frame measurements and ignore their late acknowledgements", async () => {
  const env = setup({ seekPath: "buffered", deferSeeks: true });
  await readyPlayer(env);
  const controls = () => env.node((node) => node.type === "PlayerControls").props;
  controls().onSeek(90); controls().onSeek(120); await env.settle();
  env.frame(90); await env.settle();
  assert.equal(env.metrics()[0].status, "superseded");
  assert.equal(env.metrics()[1].status, "pending");
  env.seekRequests[0].resolve({ ...session(), seek_disposition: "buffered" }); await env.settle();
  assert.equal(env.playback.clock.current.position, 120);
  env.advance(15); env.frame(120); await env.settle();
  assert.equal(env.metrics()[1].status, "completed");
  assert.equal(env.metrics()[1].target, 120);
  env.runner.unmount();
});

test("late play rejection from an earlier seek cannot cancel playback for the new generation", async () => {
  const env = setup({ deferSeeks: true, deferPlay: true });
  await readyPlayer(env);
  env.node((node) => node.type === "PlayerControls").props.onSeek(90); await env.settle();
  env.playRequests[0].reject(new Error("Old play interrupted")); await env.settle();
  const preparing = { ...session("preparing", 2), source_anchor: 90, requires_reload: true };
  env.seekRequests[0].resolve(preparing); env.setSession(preparing); await env.settle();
  env.setSession({ ...session("ready", 2), source_anchor: 90 }); env.engines.at(-1).ready(); await env.settle();
  assert.equal(env.playCalls, 2);
  env.runner.unmount();
});

test("retired server cache recovers production only when the local playback buffer runs low", async () => {
  const options = { seekPath: "buffered", deferSeeks: true, bufferedAhead: 30 };
  const env = setup(options); await readyPlayer(env);
  env.video.paused = false;
  env.node((node) => node.type === "PlayerControls").props.onSeek(20); await env.settle();
  env.frame(20); await env.settle();
  const acknowledgement = { ...session(), needs_recovery: true, requires_reload: false };
  env.seekRequests[0].resolve(acknowledgement); env.setSession(acknowledgement); await env.settle();
  env.videoEvent("onTimeUpdate"); await env.settle();
  assert.equal(env.seeks.length, 1);
  options.bufferedAhead = 5;
  env.videoEvent("onTimeUpdate"); env.videoEvent("onTimeUpdate"); await env.settle();
  assert.equal(env.seeks.length, 2);
  assert.equal(env.seekRequests[1].settings.clientBuffered, false);
  assert.equal(env.metrics()[1].path, "miss");
  env.runner.unmount();
});

test("paused seek fallback is explicitly labelled when video frame callbacks are unavailable", async () => {
  const env = setup({ withoutVideoFrames: true, seekPath: "buffered", deferSeeks: true });
  await readyPlayer(env);
  env.node((node) => node.type === "PlayerControls").props.onSeek(90); await env.settle();
  env.videoEvent("onSeeked"); await env.settle();
  assert.equal(env.metrics()[0].status, "completed");
  assert.equal(env.metrics()[0].frameEvidence, "seeked-fallback");
  assert.equal(env.video.paused, true);
  env.runner.unmount();
});

test("mode selection uses native file playback without a playlist and remux aligns beyond its preceding keyframe", async () => {
  const direct = setup();
  await readyPlayer(direct, { ...session(), playback_mode: "direct", playlist_url: null, stream_url: "/stream", position: 0 });
  assert.equal(direct.nativeEngines.length, 1);
  direct.runner.unmount();
  const remux = setup();
  await readyPlayer(remux, { ...session(), playback_mode: "remux", source_anchor: 80, position: 90 });
  assert.equal(remux.nativeEngines.length, 0);
  assert.equal(remux.video.currentTime, 10);
  assert.equal(remux.engines[0].getSourceTime(), 90);
  remux.runner.unmount();
});

test("native playback failure falls back once while preserving paused position, volume and rate", async () => {
  const env = setup();
  await readyPlayer(env, { ...session(), playback_mode: "direct", stream_url: "/stream", position: 0 });
  const controls = env.node((node) => node.type === "PlayerControls").props;
  controls.onVolume(0.3); controls.onRate(1.5);
  env.video.currentTime = 77; env.videoEvent("onPause"); await env.settle();
  env.engines[0].fail("native error"); env.engines[0].fail("duplicate error"); await env.settle();
  assert.equal(env.fallbacks.length, 1);
  assert.equal(env.playback.error, null);
  assert.equal(env.playback.clock.current.position, 77);
  const preparing = { ...session("preparing", 2), playback_mode: "transcode", source_anchor: 77, position: 77 };
  env.fallbacks[0].resolve(preparing); env.setSession(preparing); await env.settle();
  env.setSession({ ...preparing, status: "ready", playlist_url: "/fallback.m3u8" });
  env.engines.at(-1).ready(); await env.settle();
  assert.equal(env.video.volume, 0.3);
  assert.equal(env.video.playbackRate, 1.5);
  assert.equal(env.playCalls, 1, "Fallback must preserve the user's paused intent");
  env.engines.at(-1).fail("transcode error"); await env.settle();
  assert.equal(env.fallbacks.length, 1);
  assert.equal(env.playback.error, "transcode error");
  env.runner.unmount();
});

test("old frames and playing events cannot finish a seek while the element is still seeking", async () => {
  const env = setup({ seekPath: "server-cache", deferSeeks: true }); await readyPlayer(env);
  env.node((node) => node.type === "PlayerControls").props.onSeek(90); await env.settle();
  env.video.seeking = true;
  env.frame(90); env.videoEvent("onPlaying"); await env.settle();
  assert.equal(env.metrics()[0].status, "pending");
  assert.equal(env.node((node) => node.type === "PlayerControls").props.buffering, true);
  env.video.seeking = false;
  env.frame(89.5); await env.settle();
  assert.equal(env.metrics()[0].status, "pending", "A frame half a second before the target is not a target frame");
  env.frame(90); await env.settle();
  assert.equal(env.metrics()[0].status, "completed");
  env.runner.unmount();
});

test("target verification supports low frame rates and a delayed callback during playback", async () => {
  const lowRate = setup({ frameRate: 12, seekPath: "buffered", deferSeeks: true });
  await readyPlayer(lowRate);
  lowRate.node((node) => node.type === "PlayerControls").props.onSeek(90); await lowRate.settle();
  lowRate.frame(90 + 1 / 12); await lowRate.settle();
  assert.equal(lowRate.metrics()[0].status, "completed");
  lowRate.runner.unmount();
  const delayed = setup({ seekPath: "buffered", deferSeeks: true }); await readyPlayer(delayed);
  delayed.video.paused = false;
  delayed.node((node) => node.type === "PlayerControls").props.onSeek(90); await delayed.settle();
  delayed.advance(400); delayed.frame(90.4); await delayed.settle();
  assert.equal(delayed.metrics()[0].status, "completed", "A late main-thread callback must not lock the target forever");
  assert.equal(delayed.metrics()[0].firstFrameMs, 400);
  delayed.runner.unmount();
});

test("a direct Range seek acknowledgement does not assign the same native seek a second time", async () => {
  const env = setup({ deferSeeks: true });
  const direct = { ...session(), playback_mode: "direct", stream_url: "/stream", position: 0 };
  await readyPlayer(env, direct);
  env.node((node) => node.type === "PlayerControls").props.onSeek(90); await env.settle();
  assert.equal(env.nativeEngines[0].seekCalls, 1);
  env.seekRequests[0].resolve({ ...direct, position: 90, requires_reload: false }); await env.settle();
  assert.equal(env.nativeEngines[0].seekCalls, 1);
  env.runner.unmount();
});

test("an error-induced pause does not cancel playing intent during the compatibility fallback", async () => {
  const env = setup();
  await readyPlayer(env, { ...session(), playback_mode: "direct", stream_url: "/stream", position: 0 });
  env.video.paused = false; env.videoEvent("onPlaying");
  env.engines[0].fail("native error");
  env.video.paused = true; env.video.error = { code: 4 }; env.videoEvent("onPause"); await env.settle();
  const preparing = { ...session("preparing", 2), playback_mode: "transcode", source_anchor: 0, position: 0 };
  env.fallbacks[0].resolve(preparing); env.setSession(preparing); await env.settle();
  env.videoEvent("onPlaying"); await env.settle();
  assert.equal(env.node((node) => node.type === "PlayerControls").props.buffering, true);
  env.video.error = null;
  env.setSession({ ...preparing, status: "ready", playlist_url: "/fallback.m3u8" });
  env.engines.at(-1).ready(); await env.settle();
  assert.equal(env.playCalls, 2);
  env.runner.unmount();
});

test("a paused target frame observed before seeked is confirmed later without waiting for another frame", async () => {
  const env = setup({ seekPath: "buffered", deferSeeks: true }); await readyPlayer(env);
  env.node((node) => node.type === "PlayerControls").props.onSeek(10); await env.settle();
  env.video.seeking = true;
  env.advance(6); env.frame(10); await env.settle();
  assert.equal(env.metrics()[0].status, "pending");
  env.advance(100); env.video.seeking = false; env.videoEvent("onSeeked"); await env.settle();
  assert.equal(env.metrics()[0].status, "completed");
  assert.equal(env.metrics()[0].firstFrameMs, 6, "Confirmation must retain the actual frame observation time");
  assert.equal(env.metrics()[0].frameEvidence, "video-frame");
  assert.equal(env.video.paused, true);
  env.runner.unmount();
});

test("a native paused frame before its clock acknowledgement is retained through seeked and completed by the acknowledgement", async () => {
  const env = setup({ deferSeeks: true });
  const direct = { ...session(), playback_mode: "direct", stream_url: "/stream", position: 0 };
  await readyPlayer(env, direct);
  env.node((node) => node.type === "PlayerControls").props.onSeek(10); await env.settle();
  env.video.seeking = true;
  env.advance(5); env.frame(10); await env.settle();
  env.video.seeking = false; env.videoEvent("onSeeked"); await env.settle();
  assert.equal(env.metrics()[0].status, "pending");
  env.advance(30);
  env.seekRequests[0].resolve({ ...direct, position: 10, requires_reload: false }); await env.settle();
  assert.equal(env.metrics()[0].status, "completed");
  assert.equal(env.metrics()[0].firstFrameMs, 5);
  assert.equal(env.metrics()[0].frameEvidence, "video-frame");
  assert.equal(env.nativeEngines[0].seekCalls, 1);
  env.runner.unmount();
});

test("paused forward and backward seeks can each complete from their only frame, including a previously displayed target", async () => {
  const env = setup({ seekPath: "buffered", deferSeeks: true });
  await readyPlayer(env, { ...session(), playback_mode: "direct", stream_url: "/stream", position: 0 });
  for (const target of [10, 20, 10]) {
    env.node((node) => node.type === "PlayerControls").props.onSeek(target); await env.settle();
    env.video.seeking = true;
    env.advance(6); env.frame(target); await env.settle();
    env.video.seeking = false; env.videoEvent("onSeeked"); await env.settle();
    assert.equal(env.metrics().at(-1).status, "completed");
    assert.equal(env.metrics().at(-1).frameSourceTime, target);
    assert.equal(env.metrics().at(-1).firstFrameMs, 6);
  }
  assert.equal(env.metrics().length, 3);
  assert.equal(env.video.paused, true);
  env.runner.unmount();
});

test("seeked cannot reuse a deferred frame from a superseded target", async () => {
  const env = setup({ seekPath: "buffered", deferSeeks: true }); await readyPlayer(env);
  env.node((node) => node.type === "PlayerControls").props.onSeek(10); await env.settle();
  env.video.seeking = true; env.frame(10); await env.settle();
  env.node((node) => node.type === "PlayerControls").props.onSeek(20); await env.settle();
  env.video.seeking = false; env.videoEvent("onSeeked"); await env.settle();
  assert.equal(env.metrics()[0].status, "superseded");
  assert.equal(env.metrics()[1].status, "pending", "Seeked alone is not video-frame evidence");
  env.frame(20); await env.settle();
  assert.equal(env.metrics()[1].status, "completed");
  env.runner.unmount();
});
