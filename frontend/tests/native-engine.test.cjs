const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function compile(path) {
  return ts.transpileModule(fs.readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const engineModule = { exports: {} }, typesModule = { exports: {} };
vm.runInNewContext(compile("../src/lib/player/engine.ts"), engineModule);
vm.runInNewContext(compile("../src/lib/player/types.ts"), typesModule);
const compiled = compile("../src/lib/player/native-engine.ts");

function snapshot(extra = {}) {
  return { id: "a", generation: 1, duration: 600, position: 90, source_anchor: 90, playback_mode: "direct", timeline_mode: "source", stream_url: "/api/v1/playback/sessions/a/1/stream", ...extra };
}
function setup(value = snapshot()) {
  let ready = 0; const errors = [];
  const video = Object.assign(new EventTarget(), {
    currentTime: 0, readyState: 0, seeking: false, paused: true, loads: 0, pauses: 0,
    buffered: { length: 1, start: () => 100, end: () => 140 },
    load() { this.loads++; }, pause() { this.pauses++; this.paused = true; },
    removeAttribute(name) { delete this[name]; },
  });
  const sandbox = {
    exports: {}, URL, Error,
    window: { location: { href: "http://localhost:5173/watch/a", origin: "http://localhost:5173" } },
    require(name) {
      if (name === "./engine") return engineModule.exports;
      if (name === "./types") return typesModule.exports;
      throw new Error(name);
    },
  };
  vm.runInNewContext(compiled, sandbox);
  const engine = new sandbox.exports.NativeEngine(video, value, (message) => errors.push(message), () => ready++);
  return { engine, video, errors, get ready() { return ready; }, event(name) { video.dispatchEvent(new Event(name)); } };
}

test("direct playback aligns the source timeline on metadata and waits for data at that position", () => {
  const env = setup();
  assert.equal(env.video.src, "http://localhost:5173/api/v1/playback/sessions/a/1/stream");
  assert.equal(env.video.crossOrigin, undefined, "Same-origin media uses the browser's normal authenticated request");
  env.video.readyState = 1; env.event("loadedmetadata");
  assert.equal(env.video.currentTime, 90);
  env.video.readyState = 2; env.video.seeking = true; env.event("loadeddata");
  assert.equal(env.ready, 0);
  env.video.seeking = false; env.event("seeked"); env.event("canplay");
  assert.equal(env.ready, 1);
  assert.equal(env.engine.getSourceTime(120), 120, "Direct source time must not double-add source_anchor");
  env.engine.destroy();
});

test("native seeks distinguish browser buffers from an unbuffered Range load", () => {
  const env = setup();
  assert.equal(env.engine.seek(120), "miss", "Metadata must exist before assigning a seek target");
  env.video.readyState = 2;
  assert.equal(env.engine.seek(120), "buffered");
  assert.equal(env.engine.getBufferedAhead(), 20);
  assert.equal(env.engine.seek(200), "miss");
  assert.equal(env.video.currentTime, 200, "The browser can already start its Range request before clock acknowledgement");
  assert.equal(env.engine.getBufferedAhead(), 0);
  env.engine.destroy();
});

test("native errors are removed on destruction and stale session updates cannot change the clock", () => {
  const env = setup();
  env.event("error"); assert.equal(env.errors.length, 1);
  env.engine.update(snapshot({ id: "other", duration: 5 }));
  assert.equal(env.engine.getSourceTime(120), 120);
  env.engine.destroy(); env.engine.destroy(); env.event("error");
  assert.equal(env.errors.length, 1);
  assert.equal(env.video.pauses, 1);
  assert.equal(env.video.loads, 2);
  assert.equal(env.video.src, undefined);
});

test("native streams reject cross-origin URLs before touching the video element", () => {
  assert.throws(() => setup(snapshot({ stream_url: "https://other.example/stream" })), /同源/);
  assert.throws(() => setup(snapshot({ stream_url: undefined })), /不可用/);
});
