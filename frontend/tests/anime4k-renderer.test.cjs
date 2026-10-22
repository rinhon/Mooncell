// Lifecycle tests use a fake WebGPU device. Real shader execution still requires
// the browser acceptance checks recorded in docs/video-playback-p0-anime4k.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(require.resolve("../src/lib/player/anime4k-renderer.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(overrides = {}) {
  const devices = [];
  const animationFrames = new Map();
  const videoFrames = new Map();
  const notices = [];
  let callbackId = 0;
  let clock = 0;
  let latency = 1;
  let observerDisconnected = false;
  const video = Object.assign(new EventTarget(), {
    videoWidth: 1280, videoHeight: 720, readyState: 4, HAVE_CURRENT_DATA: 2,
    paused: true, seeking: false, ended: false, playbackRate: 1,
    requestVideoFrameCallback(callback) { const id = ++callbackId; videoFrames.set(id, callback); return id; },
    cancelVideoFrameCallback(id) { videoFrames.delete(id); },
  });
  Object.defineProperty(video, "currentTime", { get() { return 17; }, set() { throw new Error("renderer changed media clock"); } });
  video.play = video.pause = () => { throw new Error("renderer changed playback state"); };
  const context = { configure() {}, unconfigure() {}, getCurrentTexture() { return { createView() { return {}; } }; } };
  const canvas = { width: 0, height: 0, getContext() { return context; } };
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), { isSecureContext: true, devicePixelRatio: 3 });
  const texture = (width, height) => ({ width, height, destroy() {}, createView() { return {}; } });
  function makeDevice() {
    const lost = deferred();
    const device = Object.assign(new EventTarget(), {
      limits: { maxTextureDimension2D: 8192 },
      lost: lost.promise,
      lostEvent: lost,
      destroyed: 0,
      copies: 0,
      destroy() { this.destroyed++; lost.resolve({ reason: "destroyed" }); },
      createTexture({ size }) { return texture(size[0], size[1]); },
      createShaderModule() { return {}; },
      createRenderPipeline() { return { getBindGroupLayout() { return {}; } }; },
      createBindGroup() { return {}; }, createSampler() { return {}; },
      pushErrorScope() {}, async popErrorScope() { return null; },
      createCommandEncoder() {
        return {
          beginRenderPass() { return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }; },
          finish() { return {}; },
        };
      },
    });
    device.queue = {
      copyExternalImageToTexture() { device.copies++; }, submit() {},
      async onSubmittedWorkDone() {},
    };
    devices.push(device);
    return device;
  }
  const adapter = { async requestDevice() { return makeDevice(); } };
  const navigator = { gpu: { async requestAdapter() { return adapter; }, getPreferredCanvasFormat() { return "bgra8unorm"; } } };
  class Model {
    constructor({ inputTexture }) { this.output = texture(inputTexture.width * 2, inputTexture.height * 2); }
    getOutputTexture() { return this.output; }
    pass() {}
  }
  const sandbox = {
    exports: {}, require: () => ({ CNNx2M: Model, CNNx2VL: Model }),
    window, document, navigator,
    GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 },
    performance: { now() { clock += latency; return clock; } },
    requestAnimationFrame(callback) { const id = ++callbackId; animationFrames.set(id, callback); return id; },
    cancelAnimationFrame(id) { animationFrames.delete(id); },
    ResizeObserver: class { observe() {} disconnect() { observerDisconnected = true; } },
  };
  overrides.configure?.({ sandbox, video, adapter, navigator, window, makeDevice });
  vm.runInNewContext(compiled, sandbox, { filename: "anime4k-renderer.js" });
  const renderer = sandbox.exports.createAnime4kRenderer({
    video, canvas, container: { getBoundingClientRect() { return { width: 1920, height: 1080 }; } },
    onNotice: (message) => notices.push(message),
    ...overrides.options,
  });
  async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
  async function flush() {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    callbacks.forEach((callback) => callback());
    await settle();
  }
  return {
    renderer, video, canvas, devices, notices, adapter, animationFrames, videoFrames,
    settle, flush, setLatency(value) { latency = value; },
    get observerDisconnected() { return observerDisconnected; },
    async frame(index) {
      const callbacks = [...videoFrames.values()]; videoFrames.clear();
      callbacks.forEach((callback) => callback(0, { presentedFrames: index, mediaTime: index / 30 }));
      await settle();
    },
  };
}

test("insecure context falls back without requesting GPU or touching the media clock", async () => {
  const env = setup({ configure({ window }) { window.isSecureContext = false; } });
  await env.renderer.setMode("standard");
  assert.equal(env.renderer.getState().status, "unavailable");
  assert.equal(env.devices.length, 0);
  assert.equal(env.video.currentTime, 17);
  env.renderer.destroy();
});

test("destroy during asynchronous device creation destroys the late device", async () => {
  const gate = deferred();
  const env = setup({ configure({ adapter }) { adapter.requestDevice = () => gate.promise; } });
  const initializing = env.renderer.setMode("light");
  await env.settle();
  env.renderer.destroy();
  let destroyed = 0;
  gate.resolve({ destroy() { destroyed++; } });
  await initializing;
  assert.equal(destroyed, 1);
  assert.equal(env.renderer.getState().status, "destroyed");
  assert.equal(env.videoFrames.size, 0);
});

test("paused seek refreshes the static frame; output honors DPR and pixel limit", async () => {
  const env = setup({ options: { maxOutputPixels: 1280 * 720 } });
  await env.renderer.setMode("standard");
  await env.flush();
  assert.equal(env.renderer.getState().effectiveMode, "standard");
  assert.equal(env.devices[0].copies, 1);
  assert.ok(env.canvas.width * env.canvas.height <= 1280 * 720);
  env.video.dispatchEvent(new Event("seeked"));
  await env.flush();
  assert.equal(env.devices[0].copies, 2);
  assert.equal(env.videoFrames.size, 0);
  env.renderer.destroy();
});

test("mode replacement and repeated destroy leave no callbacks, observers or devices", async () => {
  const env = setup();
  env.video.paused = false;
  await env.renderer.setMode("standard");
  await env.flush();
  await env.renderer.setMode("light");
  await env.flush();
  assert.equal(env.devices[0].destroyed, 1);
  assert.equal(env.videoFrames.size, 1);
  env.renderer.destroy();
  env.renderer.destroy();
  assert.equal(env.devices[1].destroyed, 1);
  assert.equal(env.videoFrames.size, 0);
  assert.equal(env.animationFrames.size, 0);
  assert.equal(env.observerDisconnected, true);
});

test("changing the source resolution rebuilds the model on a new owned device", async () => {
  const env = setup();
  await env.renderer.setMode("light");
  await env.flush();
  env.video.videoWidth = 1920; env.video.videoHeight = 1080;
  env.video.dispatchEvent(new Event("resize"));
  await env.settle(); await env.flush();
  assert.equal(env.devices.length, 2);
  assert.equal(env.devices[0].destroyed, 1);
  assert.equal(env.renderer.getState().effectiveMode, "light");
  env.renderer.destroy();
});

test("a lost GPU is rebuilt once; a second loss falls back to normal video", async () => {
  const env = setup();
  await env.renderer.setMode("standard"); await env.flush();
  env.devices[0].lostEvent.resolve({ reason: "unknown" });
  await env.settle(); await env.flush();
  assert.equal(env.devices.length, 2);
  env.devices[1].lostEvent.resolve({ reason: "unknown" });
  await env.settle();
  assert.equal(env.renderer.getState().effectiveMode, "off");
  assert.equal(env.renderer.getState().status, "unavailable");
  assert.equal(env.notices.length, 1);
  env.renderer.destroy();
});

test("sustained slow frames degrade standard to light to off with one notice", async () => {
  const env = setup();
  env.video.paused = false;
  env.setLatency(100);
  await env.renderer.setMode("standard"); await env.flush();
  for (let i = 1; i <= 30; i++) { await env.frame(i); await env.flush(); }
  assert.ok(env.devices.length >= 2);
  for (let i = 31; i <= 65; i++) { await env.frame(i); await env.flush(); }
  assert.equal(env.renderer.getState().effectiveMode, "off");
  assert.equal(env.renderer.getState().status, "unavailable");
  assert.equal(env.notices.length, 1);
  env.video.dispatchEvent(new Event("resize")); await env.settle();
  assert.equal(env.renderer.getState().effectiveMode, "off");
  env.renderer.destroy();
});
