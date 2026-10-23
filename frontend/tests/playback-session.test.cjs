const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/hooks/use-playback-session.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function info(id) { return { media_id: id, version: id, supported: true, qualities: [720, 1080], audio_tracks: [], progress: null }; }
function session(id = "session-a", generation = 1, status = "ready") { return { id, generation, status, error: null, source_anchor: 0, segments: [] }; }

function setup(options = {}) {
  const requests = [];
  const timers = new Map();
  const runners = [];
  let timerId = 0, active, uuid = 0;
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  function api(path, init = {}) {
    const request = { path, method: init.method ?? "GET", keepalive: Boolean(init.keepalive), signal: init.signal, body: init.body ? JSON.parse(init.body) : null, ...deferred() };
    requests.push(request);
    if (request.method === "PUT" || request.method === "DELETE") request.resolve({});
    return request.promise;
  }
  function depsEqual(left, right) { return left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])); }
  const react = {
    useState(initial) {
      const runner = active, index = runner.cursor++;
      if (!runner.slots[index]) runner.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      const setter = (next) => { const slot = runner.slots[index]; const value = typeof next === "function" ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; runner.dirty = true; } };
      return [runner.slots[index].value, setter];
    },
    useRef(initial) { const runner = active, index = runner.cursor++; return runner.slots[index] ??= { current: initial }; },
    useCallback(callback, deps) { const runner = active, index = runner.cursor++; const old = runner.slots[index]; if (!old || !depsEqual(old.deps, deps)) runner.slots[index] = { callback, deps }; return runner.slots[index].callback; },
    useEffect(create, deps) {
      const runner = active, index = runner.cursor++; const old = runner.slots[index];
      if (!old || !depsEqual(old.deps, deps)) {
        runner.effects.push(() => { old?.cleanup?.(); const slot = { create, deps }; runner.slots[index] = slot; slot.cleanup = create(); });
      }
    },
  };
  const window = Object.assign(new EventTarget(), { setInterval(callback, duration) { const id = ++timerId; timers.set(id, { callback, duration }); return id; }, clearInterval(id) { timers.delete(id); } });
  const storage = options.storage ?? new Map();
  Object.defineProperty(window, "sessionStorage", { get() {
    if (options.restrictedStorage) throw new Error("storage restricted");
    return { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); } };
  } });
  const cryptoProvider = options.noCrypto ? undefined : {
    ...(options.missingRandomUUID ? {} : { randomUUID() { return `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`; } }),
    getRandomValues(array) { const seed = ++uuid * 37; for (let index = 0; index < array.length; index++) array[index] = (seed + index * 11) & 255; return array; },
  };
  const sandbox = {
    exports: {}, require(name) { if (name === "react") return react; if (name === "@/lib/api") return { api, ApiError }; throw new Error(name); },
    window, Error, AbortController, clearInterval: window.clearInterval, crypto: cryptoProvider,
    document: { createElement() { return { canPlayType(mime) { return options.nativeMime === mime ? "probably" : ""; } }; } },
    MediaSource: { isTypeSupported(mime) { return options.hlsMime === mime; } },
  };
  vm.runInNewContext(compiled, sandbox, { filename: "use-playback-session.js" });
  class Runner {
    constructor(mediaId) { this.slots = []; this.mediaId = mediaId; this.info = { ...info(mediaId), ...options.info }; this.effects = []; this.dirty = false; this.mounted = true; runners.push(this); this.render(); }
    render() { if (!this.mounted) return; this.cursor = 0; this.effects = []; this.dirty = false; active = this; this.result = sandbox.exports.usePlaybackSession(this.mediaId, this.info); active = null; this.effects.forEach((effect) => effect()); }
    change(mediaId) { this.mediaId = mediaId; this.info = info(mediaId); this.render(); }
    strictReplay() { this.slots.filter((slot) => slot?.create).forEach((slot) => slot.cleanup?.()); this.slots.filter((slot) => slot?.create).forEach((slot) => { slot.cleanup = slot.create(); }); }
    unmount() { if (!this.mounted) return; this.mounted = false; this.slots.filter((slot) => slot?.create).forEach((slot) => slot.cleanup?.()); }
  }
  return {
    requests, timers, Runner, ApiError, storage,
    transition(type, persisted = false) { const event = new Event(type); Object.defineProperty(event, "persisted", { value: persisted }); window.dispatchEvent(event); },
    async settle() { for (let i = 0; i < 35; i++) { await Promise.resolve(); runners.forEach((runner) => { if (runner.dirty) runner.render(); }); } },
    tick(duration) { [...timers.values()].filter((timer) => timer.duration === duration).forEach((timer) => timer.callback()); },
    calls(method, ending) { return requests.filter((request) => request.method === method && (!ending || request.path.endsWith(ending))); },
  };
}

test("StrictMode replay cancels the first effect before a create request is sent", async () => {
  const env = setup(), runner = new env.Runner("a");
  runner.strictReplay(); await env.settle();
  assert.equal(env.calls("POST", "/sessions").length, 1);
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  assert.equal(runner.result.session.id, "session-a");
  runner.unmount(); await env.settle();
  assert.equal(env.calls("DELETE").length, 1);
  assert.equal(env.timers.size, 0);
});

test("rapid media changes reclaim a late created session before creating the next", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  const first = env.calls("POST", "/sessions")[0];
  runner.change("b"); await env.settle();
  assert.equal(env.calls("POST", "/sessions").length, 1);
  first.resolve(session("old")); await env.settle();
  const creates = env.calls("POST", "/sessions");
  assert.equal(creates.length, 2);
  assert.equal(creates[1].body.media_id, "b");
  assert.ok(env.requests.findIndex((request) => request.method === "DELETE" && request.path.endsWith("/old")) < env.requests.indexOf(creates[1]));
  creates[1].resolve(session("new")); await env.settle();
  assert.equal(runner.result.session.id, "new");
  runner.unmount(); await env.settle();
});

test("continuous seeks coalesce pending targets and never display the superseded generation", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  runner.result.seek(100); await env.settle();
  runner.result.seek(200); runner.result.seek(300); await env.settle();
  assert.equal(env.calls("POST", "/seek").length, 1);
  env.calls("POST", "/seek")[0].resolve(session("session-a", 2, "preparing")); await env.settle();
  assert.equal(runner.result.session.generation, 1);
  const seeks = env.calls("POST", "/seek");
  assert.equal(seeks.length, 2);
  assert.equal(seeks[1].body.position, 300);
  assert.equal(seeks[1].body.generation, 2);
  seeks[1].resolve(session("session-a", 3)); await env.settle();
  assert.equal(runner.result.session.generation, 3);
  assert.equal(runner.result.locating, false);
  runner.unmount(); await env.settle();
});

test("heartbeat and poll snapshots cannot overwrite a newer control response", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  runner.result.heartbeat(); env.tick(1500); await env.settle();
  runner.result.seek(200); await env.settle();
  const before = env.requests.length; runner.result.heartbeat(); env.tick(1500); await env.settle();
  assert.equal(env.requests.length, before);
  env.calls("POST", "/seek")[0].resolve(session("session-a", 2)); await env.settle();
  env.calls("POST", "/heartbeat")[0].resolve(session("session-a", 1, "paused"));
  env.calls("GET")[0].resolve(session("session-a", 1)); await env.settle();
  assert.equal(runner.result.session.generation, 2);
  assert.equal(runner.result.session.status, "ready");
  runner.unmount(); await env.settle();
});

test("older poll responses do not regress a newer heartbeat snapshot in the same generation", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session("session-a", 1, "preparing")); await env.settle();
  env.tick(1500); runner.result.heartbeat(); await env.settle();
  env.calls("POST", "/heartbeat")[0].resolve(session()); await env.settle();
  env.calls("GET")[0].resolve(session("session-a", 1, "preparing")); await env.settle();
  assert.equal(runner.result.session.status, "ready");
  runner.unmount(); await env.settle();
});

test("authentication expiry stops polling, heartbeat, progress and subsequent controls", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  runner.result.heartbeat(); await env.settle();
  env.calls("POST", "/heartbeat")[0].reject(new env.ApiError(401, "登录已过期")); await env.settle();
  const count = env.requests.length;
  runner.result.heartbeat(); runner.result.save(); runner.result.seek(300); env.tick(1500); env.tick(15000); await env.settle();
  assert.equal(env.requests.length, count);
  assert.equal(runner.result.error, "登录已过期");
  runner.unmount(); await env.settle();
});

test("an old session authentication failure cannot poison the new media lifecycle", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session("old")); await env.settle();
  runner.result.heartbeat(); await env.settle();
  const staleHeartbeat = env.calls("POST", "/heartbeat")[0];
  runner.change("b"); await env.settle();
  env.calls("POST", "/sessions")[1].resolve(session("new")); await env.settle();
  staleHeartbeat.reject(new env.ApiError(401, "旧会话过期")); await env.settle();
  assert.equal(runner.result.error, null);
  runner.result.heartbeat(); await env.settle();
  assert.equal(env.calls("POST", "/heartbeat").at(-1).path, "/playback/sessions/new/heartbeat");
  runner.unmount(); await env.settle();
});

test("seek during session creation waits for its ID and is then applied", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  runner.result.seek(300); await env.settle();
  assert.equal(env.calls("POST", "/seek").length, 0);
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  assert.equal(env.calls("POST", "/seek")[0].body.position, 300);
  env.calls("POST", "/seek")[0].resolve(session("session-a", 2)); await env.settle();
  runner.unmount(); await env.settle();
});

test("old controls finish before session deletion and the next media create", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session("old")); await env.settle();
  runner.result.seek(250); await env.settle();
  runner.change("b"); await env.settle();
  assert.equal(env.calls("DELETE").length, 0);
  assert.equal(env.calls("POST", "/sessions").length, 1);
  env.calls("POST", "/seek")[0].resolve(session("old", 2)); await env.settle();
  assert.equal(env.calls("DELETE")[0].path, "/playback/sessions/old");
  assert.equal(env.calls("POST", "/sessions").length, 2);
  assert.equal(runner.result.session, null);
  env.calls("POST", "/sessions")[1].resolve(session("new")); await env.settle();
  assert.equal(runner.result.session.id, "new");
  runner.unmount(); await env.settle();
});

test("heartbeat bursts are coalesced and the queued send uses the latest media state", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  runner.result.heartbeat(); runner.result.heartbeat(); runner.result.heartbeat(); await env.settle();
  assert.equal(env.calls("POST", "/heartbeat").length, 1);
  runner.result.clock.current.position = 35; runner.result.clock.current.paused = false;
  env.calls("POST", "/heartbeat")[0].resolve(session()); await env.settle();
  assert.equal(env.calls("POST", "/heartbeat").length, 2);
  assert.equal(env.calls("POST", "/heartbeat")[1].body.position, 35);
  assert.equal(env.calls("POST", "/heartbeat")[1].body.paused, false);
  env.calls("POST", "/heartbeat")[1].resolve(session()); await env.settle();
  runner.unmount(); await env.settle();
});

test("auth failure of a superseded seek prevents the newer queued seek from retrying", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  runner.result.seek(100); await env.settle(); runner.result.seek(300); await env.settle();
  env.calls("POST", "/seek")[0].reject(new env.ApiError(403, "登录已过期")); await env.settle();
  assert.equal(env.calls("POST", "/seek").length, 1);
  assert.equal(runner.result.error, "登录已过期");
  assert.equal(runner.result.locating, false);
  runner.unmount(); await env.settle();
});

test("pagehide immediately saves progress and closes its session with keepalive", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  runner.result.clock.current.position = 42;
  env.transition("pagehide"); await env.settle();
  assert.equal(env.calls("PUT", "/progress").length, 1);
  assert.equal(env.calls("PUT", "/progress")[0].body.position, 42);
  assert.equal(env.calls("PUT", "/progress")[0].keepalive, true);
  assert.equal(env.calls("DELETE")[0].path, "/playback/sessions/session-a");
  assert.equal(env.calls("DELETE")[0].keepalive, true);
  const count = env.requests.length;
  env.transition("pagehide"); env.tick(1500); env.tick(15000); await env.settle();
  assert.equal(env.requests.length, count);
  runner.unmount(); await env.settle();
  assert.equal(env.calls("DELETE").length, 1);
});

test("a session created after pagehide is reclaimed instead of accepted", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.transition("pagehide");
  env.calls("POST", "/sessions")[0].resolve(session("late")); await env.settle();
  assert.equal(runner.result.session, null);
  assert.equal(env.calls("DELETE")[0].path, "/playback/sessions/late");
  assert.equal(env.calls("DELETE")[0].keepalive, true);
  runner.unmount(); await env.settle();
  assert.equal(env.calls("DELETE").length, 1);
});

test("persisted pageshow restores a fresh session from the retained media clock", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session("old")); await env.settle();
  runner.result.clock.current.position = 91.5;
  env.transition("pagehide", true); await env.settle();
  env.transition("pageshow", false); await env.settle();
  assert.equal(env.calls("POST", "/sessions").length, 1);
  env.transition("pageshow", true); await env.settle();
  const creates = env.calls("POST", "/sessions");
  assert.equal(creates.length, 2);
  assert.equal(creates[1].body.start_time, 91.5);
  assert.equal(creates[1].body.client_id, creates[0].body.client_id);
  assert.equal(env.calls("DELETE").length, 1);
  creates[1].resolve(session("restored")); await env.settle();
  assert.equal(runner.result.session.id, "restored");
  runner.unmount(); await env.settle();
});

test("client_id is stable across StrictMode, explicit restart, media changes and reload storage", async () => {
  const env = setup(), runner = new env.Runner("a");
  runner.strictReplay(); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session("first")); await env.settle();
  runner.result.restart(); await env.settle();
  env.calls("POST", "/sessions")[1].resolve(session("second")); await env.settle();
  runner.change("b"); await env.settle();
  const creates = env.calls("POST", "/sessions");
  assert.equal(creates.length, 3);
  assert.match(creates[0].body.client_id, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
  assert.equal(new Set(creates.map((request) => request.body.client_id)).size, 1);
  assert.equal(new Set(creates.map((request) => request.body.request_id)).size, 3);
  assert.equal(env.storage.get("mooncell.playback.client-id"), creates[0].body.client_id);
  creates[2].resolve(session("third")); await env.settle(); runner.unmount(); await env.settle();
  const reloaded = setup({ storage: env.storage }), next = new reloaded.Runner("b"); await reloaded.settle();
  assert.equal(reloaded.calls("POST", "/sessions")[0].body.client_id, creates[0].body.client_id);
  reloaded.calls("POST", "/sessions")[0].resolve(session("reloaded")); await reloaded.settle(); next.unmount(); await reloaded.settle();
});

test("restricted sessionStorage uses one module UUID across multiple creates", async () => {
  const env = setup({ restrictedStorage: true }), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session("first")); await env.settle();
  runner.result.restart(); await env.settle();
  const creates = env.calls("POST", "/sessions");
  assert.equal(creates[0].body.client_id, creates[1].body.client_id);
  creates[1].resolve(session("second")); await env.settle(); runner.unmount(); await env.settle();
});

test("HTTP-style missing randomUUID uses valid getRandomValues UUIDs for create and controls without unhandled rejection", async () => {
  const unhandled = [];
  const record = (error) => unhandled.push(error);
  process.on("unhandledRejection", record);
  const env = setup({ missingRandomUUID: true }), runner = new env.Runner("a");
  try {
    await env.settle();
    const create = env.calls("POST", "/sessions")[0];
    const uuidV4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
    assert.match(create.body.client_id, uuidV4);
    assert.match(create.body.request_id, uuidV4);
    assert.notEqual(create.body.client_id, create.body.request_id);
    create.resolve(session()); await env.settle();
    runner.result.seek(20); await env.settle();
    const seek = env.calls("POST", "/seek")[0];
    assert.match(seek.body.request_id, uuidV4);
    seek.resolve(session("session-a", 2)); await env.settle();
    runner.result.options(720, null); await env.settle();
    const options = env.calls("PATCH", "/options")[0];
    assert.match(options.body.request_id, uuidV4);
    assert.equal(new Set([create.body.request_id, seek.body.request_id, options.body.request_id]).size, 3);
    options.resolve(session("session-a", 3)); await env.settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
    assert.equal(runner.result.error, null);
  } finally {
    runner.unmount(); await env.settle();
    process.removeListener("unhandledRejection", record);
  }
});

test("missing crypto reports a visible error without a dangling lifecycle rejection", async () => {
  const unhandled = [];
  const record = (error) => unhandled.push(error);
  process.on("unhandledRejection", record);
  const env = setup({ noCrypto: true }), runner = new env.Runner("a");
  try {
    await env.settle(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(env.calls("POST", "/sessions").length, 0);
    assert.match(runner.result.error, /浏览器无法生成播放请求标识/);
    assert.equal(unhandled.length, 0);
  } finally {
    runner.unmount(); await env.settle();
    process.removeListener("unhandledRejection", record);
  }
});

test("preparation immediately long-polls revisions and cancels the old wait for a newer seek", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve({ ...session("session-a", 1, "preparing"), revision: 1 });
  await env.settle();
  const initialPoll = env.calls("GET")[0];
  assert.equal(initialPoll.path, "/playback/sessions/session-a?after_revision=1&wait_ms=1500");
  runner.result.seek(300); await env.settle();
  assert.equal(initialPoll.signal.aborted, true);
  env.calls("POST", "/seek")[0].resolve({ ...session("session-a", 2, "preparing"), revision: 2 });
  await env.settle();
  const nextPoll = env.calls("GET").at(-1);
  assert.equal(nextPoll.path, "/playback/sessions/session-a?after_revision=2&wait_ms=1500");
  initialPoll.resolve({ ...session("session-a", 1), revision: 50 });
  nextPoll.resolve({ ...session("session-a", 2), revision: 3 }); await env.settle();
  assert.equal(runner.result.session.generation, 2);
  assert.equal(runner.result.session.status, "ready");
  assert.equal(runner.result.session.revision, 3);
  assert.equal(env.calls("GET").length, 2, "Readiness must arrive without an interval tick");
  runner.unmount(); await env.settle();
});

test("browser-buffered seeks acknowledge the clock without blocking the local picture", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve(session()); await env.settle();
  runner.result.seek(50, { clientBuffered: true }); await env.settle();
  assert.equal(runner.result.locating, false);
  assert.equal(env.calls("POST", "/seek")[0].body.client_buffered, true);
  const count = env.requests.length;
  runner.result.heartbeat(); await env.settle();
  assert.equal(env.requests.length, count, "Heartbeat waits for the position acknowledgement");
  env.calls("POST", "/seek")[0].resolve({ ...session(), seek_disposition: "buffered", requires_reload: false, needs_recovery: true });
  await env.settle();
  assert.equal(runner.result.session.generation, 1);
  assert.equal(runner.result.session.needs_recovery, true);
  runner.unmount(); await env.settle();
});

test("server revisions reject a stale same-generation snapshot even when its request is newer", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve({ ...session(), revision: 4 }); await env.settle();
  runner.result.heartbeat(); await env.settle();
  env.calls("POST", "/heartbeat")[0].resolve({ ...session("session-a", 1, "paused"), revision: 3 });
  await env.settle();
  assert.equal(runner.result.session.status, "ready");
  assert.equal(runner.result.session.revision, 4);
  runner.unmount(); await env.settle();
});

test("creation negotiates the exact codec MIME types and defaults to original quality", async () => {
  const nativeMime = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
  const hlsMime = 'video/mp4; codecs="avc1.640028"';
  const env = setup({ nativeMime, hlsMime, info: { native_mime_type: nativeMime, hls_mime_type: hlsMime } });
  const runner = new env.Runner("a"); await env.settle();
  const create = env.calls("POST", "/sessions")[0];
  assert.equal(create.body.quality, 0);
  assert.deepEqual(create.body.capabilities, { native_mime_types: [nativeMime], hls_mime_types: [hlsMime] });
  create.resolve(session()); await env.settle();
  runner.unmount(); await env.settle();
});

test("fallback carries source position and forces conversion without resetting quality or audio", async () => {
  const env = setup(), runner = new env.Runner("a"); await env.settle();
  env.calls("POST", "/sessions")[0].resolve({ ...session(), quality: 0, audio_track: 2, seek_revision: 7 }); await env.settle();
  runner.result.clock.current.position = 95;
  runner.result.fallback(); await env.settle();
  const request = env.calls("PATCH", "/options")[0];
  assert.equal(request.body.force_transcode, true);
  assert.equal(request.body.position, 95);
  assert.equal(request.body.quality, 0);
  assert.equal(request.body.audio_track, 2);
  request.resolve({ ...session("session-a", 2), seek_revision: 8 }); await env.settle();
  runner.result.heartbeat(); runner.result.save(); await env.settle();
  assert.equal(env.calls("POST", "/heartbeat")[0].body.seek_revision, 8);
  assert.equal(env.calls("PUT", "/progress")[0].body.seek_revision, 8);
  runner.unmount(); await env.settle();
});
