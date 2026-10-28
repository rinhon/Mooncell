const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function setup() {
  let active, clock = 0, timerId = 0;
  const timers = new Map(), runners = [], modules = new Map(), queries = new Map(), queryOptions = [];
  class TrackedTarget extends EventTarget {
    listeners = new Map();
    addEventListener(type, listener) { super.addEventListener(type, listener); if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { super.removeEventListener(type, listener); this.listeners.get(type)?.delete(listener); }
    count(type) { return this.listeners.get(type)?.size ?? 0; }
  }
  const window = Object.assign(new TrackedTarget(), {
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const document = Object.assign(new TrackedTarget(), { visibilityState: "visible" });
  const navigator = { onLine: true };
  const equal = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    createContext(defaultValue) { return { defaultValue }; },
    useContext(context) { return context.defaultValue; },
    useState(initial) {
      const runner = active, index = runner.cursor++;
      if (!runner.slots[index]) runner.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [runner.slots[index].value, next => { const slot = runner.slots[index]; const value = typeof next === "function" ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; runner.dirty = true; } }];
    },
    useRef(initial) { return active.slots[active.cursor++] ??= { current: initial }; },
    useCallback(callback, deps) { const runner = active, index = runner.cursor++; if (!equal(runner.slots[index]?.deps, deps)) runner.slots[index] = { value: callback, deps }; return runner.slots[index].value; },
    useEffect(create, deps) {
      const runner = active, index = runner.cursor++, previous = runner.slots[index];
      if (!equal(previous?.deps, deps)) runner.effects.push(() => { previous?.cleanup?.(); const slot = { create, deps }; runner.slots[index] = slot; slot.cleanup = create(); });
    },
  };
  const jsx = (type, props, key) => ({ type, props, key: key == null ? null : String(key) });
  react.createElement = (type, props, ...children) => { const { key, ...rest } = props ?? {}; return jsx(type, children.length ? { ...rest, children: children.length === 1 ? children[0] : children } : rest, key); };
  const primitives = new Proxy({}, { get: (_, name) => name });
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const exports = {};
    const compiled = ts.transpileModule(fs.readFileSync(require.resolve(`../src/${path}`), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    vm.runInNewContext(compiled, { exports, window, document, navigator, require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "motion/react") return { motion: { img: "motion.img" }, useReducedMotion: () => false };
      if (name === "@tanstack/react-query") return {
        useQuery(options) { queryOptions.push(options); return { isPending: false, isError: false, isFetching: false, refetch() {}, ...queries.get(options.queryKey[0]) }; },
        useQueryClient: () => ({ invalidateQueries() {} }), useMutation: () => ({ isPending: false }),
      };
      if (name === "@/hooks/use-image-recovery") return load("hooks/use-image-recovery.ts");
      if (name === "@/lib/show-artwork") return load("lib/show-artwork.ts");
      if (name === "@/lib/poster-hover") return load("lib/poster-hover.ts");
      if (name === "@/components/ui/fade-in-image") return load("components/ui/fade-in-image.tsx");
      if (name === "@/lib/api") return { api: path => path };
      if (name === "@/lib/motion") return { spring: { gentle: {} } };
      if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
      if (name === "@/components/ui/toast") return { useToast: () => () => {} };
      if (name.endsWith(".css")) return {};
      if (name === "lucide-react" || name.startsWith("@/components/")) return primitives;
      throw new Error(`Unexpected import: ${name}`);
    } }, { filename: path });
    modules.set(path, exports);
    return exports;
  }
  class Runner {
    constructor(component, props) { this.component = component; this.props = props; this.slots = []; this.mounted = true; runners.push(this); this.render(); }
    render() { if (!this.mounted) return; this.cursor = 0; this.effects = []; this.dirty = false; active = this; this.result = this.component(this.props); active = null; this.effects.forEach(effect => effect()); }
    strictReplay() { const effects = this.slots.filter(slot => slot?.create); effects.forEach(slot => slot.cleanup?.()); effects.forEach(slot => { slot.cleanup = slot.create(); }); }
    unmount() { this.mounted = false; this.slots.filter(slot => slot?.create).forEach(slot => slot.cleanup?.()); }
  }
  function flush() { for (let count = 0; runners.some(runner => runner.mounted && runner.dirty); count++) { assert.ok(count < 20); runners.forEach(runner => { if (runner.dirty) runner.render(); }); } }
  function advance(duration) {
    const end = clock + duration;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at; timers.delete(next[0]); next[1].callback(); flush();
    }
    clock = end;
  }
  function image(path, props) {
    const Factory = Object.values(load(path))[0];
    let element = Factory(props), runner = new Runner(element.type, element.props);
    return {
      get tree() { return runner.result; }, get node() { return runner.result.props.children[2]; },
      change(next) { const updated = Factory(next); if (updated.key !== element.key) { runner.unmount(); runner = new Runner(updated.type, updated.props); } else { runner.props = updated.props; runner.render(); } element = updated; flush(); },
      strictReplay() { runner.strictReplay(); }, unmount() { runner.unmount(); },
    };
  }
  return { load, Runner, queries, queryOptions, timers, window, document, navigator, image, flush, advance };
}

for (const path of ["components/ui/fade-in-image.tsx", "components/ui/retry-image.tsx"]) {
  test(`${path}: retries use bounded backoff, retain fallback and preserve the exact URL`, () => {
    const env = setup(), src = "/poster?v=version%2F1&size=large", fallback = { type: "fallback" };
    const image = env.image(path, { src, fallback, loading: "lazy", style: { opacity: 0.32 } });
    const first = image.node;
    first.props.onError({}); env.flush();
    assert.equal(image.tree.props.children[1], fallback);
    assert.equal(image.node, false);
    for (const delay of [1000, 3000, 10000]) {
      for (let index = 0; index < 4; index++) image.change({ src, fallback, loading: "lazy", style: { opacity: 0.32 } });
      assert.equal(env.timers.size, 1);
      assert.equal([...env.timers.values()][0].delay, delay);
      env.advance(delay - 1); assert.equal(image.node, false);
      env.advance(1);
      assert.equal(image.node.props.src, src);
      assert.equal(image.node.props.loading, "eager");
      assert.equal(image.node.props.style.display, "none");
      assert.equal(image.node.props.style.opacity, path.endsWith("fade-in-image.tsx") ? 0 : 0.32);
      assert.equal(image.tree.props.children[1], fallback);
      image.node.props.onError({}); env.flush();
    }
    assert.equal(env.timers.size, 0);
    env.advance(600000); assert.equal(image.node, false);
    image.unmount();
  });

  test(`${path}: cached refs forward one DOM event and stale attempts cannot settle retries`, () => {
    const env = setup(); let loads = 0, errors = 0;
    const props = { src: "/image?v=1", fallback: "fallback", onLoad: () => loads++, onError: () => errors++ };
    const image = env.image(path, props), first = image.node;
    first.props.ref({ complete: true, naturalWidth: 0 }); env.flush();
    first.props.onError({}); first.props.onError({});
    assert.equal(errors, 1);
    env.advance(1000);
    const retry = image.node;
    first.props.ref({ complete: true, naturalWidth: 100 }); first.props.onLoad({}); env.flush();
    assert.equal(loads, 0); assert.equal(image.tree.props.children[1], "fallback");
    retry.props.ref({ complete: true, naturalWidth: 100 }); env.flush();
    assert.equal(image.tree.props.children[1], false);
    if (path.endsWith("fade-in-image.tsx")) assert.equal(image.node.props.style.opacity, 1);
    else assert.equal(image.node.props.style, undefined);
    retry.props.onLoad({}); retry.props.onLoad({});
    assert.equal(loads, 1); assert.equal(env.timers.size, 0);
    env.window.dispatchEvent(new Event("online")); env.flush();
    assert.equal(image.node.key, retry.key);
    image.change({ ...props, src: "/image?v=2" });
    retry.props.onError({}); retry.props.onLoad({}); env.flush();
    assert.equal(image.node.props.src, "/image?v=2");
    assert.equal(image.node.key, "0"); assert.equal(env.timers.size, 0);
    image.node.props.onError({}); env.flush();
    assert.equal([...env.timers.values()][0].delay, 1000);
    image.unmount();
    assert.equal(env.timers.size, 0);
  });
}

test("visibility and reconnect recover exhausted failures; StrictMode and unmount clean resources", () => {
  const env = setup(), hook = env.load("hooks/use-image-recovery.ts").useImageRecovery;
  const runner = new env.Runner(hook);
  runner.strictReplay();
  assert.equal(env.window.count("online"), 1); assert.equal(env.document.count("visibilitychange"), 1);
  for (const delay of [1000, 3000, 10000]) { runner.result.onError(); env.flush(); env.advance(delay); }
  runner.result.onError(); env.flush(); assert.equal(env.timers.size, 0);
  env.document.visibilityState = "hidden";
  env.document.dispatchEvent(new Event("visibilitychange")); env.flush();
  assert.equal(runner.result.status, "error");
  env.navigator.onLine = false; env.document.visibilityState = "visible";
  env.document.dispatchEvent(new Event("visibilitychange")); env.flush();
  assert.equal(runner.result.status, "error");
  env.navigator.onLine = true; env.window.dispatchEvent(new Event("online")); env.flush();
  assert.equal(runner.result.status, "loading"); assert.equal(runner.result.failed, true);
  runner.result.onError(); env.flush(); assert.equal([...env.timers.values()][0].delay, 1000);
  env.document.dispatchEvent(new Event("visibilitychange")); env.flush();
  runner.result.onLoad(); env.flush();
  assert.equal(runner.result.status, "loaded"); assert.equal(runner.result.failed, false); assert.equal(env.timers.size, 0);
  const attempt = runner.result.attempt;
  env.document.dispatchEvent(new Event("visibilitychange")); env.window.dispatchEvent(new Event("online")); env.flush();
  assert.equal(runner.result.attempt, attempt);
  runner.unmount();
  assert.equal(env.window.count("online"), 0); assert.equal(env.document.count("visibilitychange"), 0);
  assert.equal(runner.result.onError(), false);
});

test("a URL change cancels pending retries and isolates old events", () => {
  const env = setup(), image = env.image("components/ui/retry-image.tsx", { src: "/image?v=1" });
  const previous = image.node;
  previous.props.onError({}); env.flush(); assert.equal(env.timers.size, 1);
  image.change({ src: "/image?v=2", placeholder: "new loading" });
  assert.equal(env.timers.size, 0); assert.equal(env.window.count("online"), 1);
  previous.props.onLoad({}); previous.props.ref({ complete: true, naturalWidth: 100 }); env.flush();
  assert.equal(image.tree.props.children[0], "new loading");
  assert.equal(image.node.props.src, "/image?v=2");
  image.unmount();
});

test("RSS background errors keep the list in the same JSX slot with stable card identities", () => {
  const env = setup(), feeds = [{ id: 3, name: "番剧", kind: "rss" }];
  env.queries.set("feeds", { data: feeds }); env.queries.set("shows", { data: [] });
  const page = new env.Runner(env.load("pages/feeds.tsx").FeedsPage);
  const section = () => page.result.props.children[1];
  const initialList = section().props.children[1], initialCard = initialList.props.children[0];
  env.queries.set("feeds", { data: feeds, isError: true, error: new Error("暂时离线") }); page.render();
  const failedList = section().props.children[1], failedCard = failedList.props.children[0];
  assert.equal(section().props.children[0].props.role, "alert");
  assert.equal(failedList.type, initialList.type); assert.equal(failedList.props.className, "feed-list");
  assert.equal(failedCard.type, initialCard.type); assert.equal(failedCard.key, initialCard.key);
  env.queries.set("feeds", { data: feeds }); page.render();
  assert.equal(section().props.children[0], false);
  assert.equal(section().props.children[1].props.children[0].key, initialCard.key);
  env.queries.set("feeds", { isError: true, error: new Error("首次读取失败") }); page.render();
  assert.equal(section().props.children[1].props.role, "alert");
  page.unmount();
});

test("clearlogo uses its independent version and retains the brightness plate and recovery component", () => {
  const env = setup();
  env.queries.set("clearlogo-appearance", { data: { background: "light" } });
  const show = { id: 3, artwork_version: "global", artwork_versions: { clearlogo: "logo/2" } };
  const component = new env.Runner(env.load("components/feed-clearlogo.tsx").FeedClearlogo, { show });
  const query = env.queryOptions.at(-1);
  assert.deepEqual([...query.queryKey], ["clearlogo-appearance", 3, "logo/2"]);
  assert.equal(query.queryFn(), "/shows/3/artwork/clearlogo/appearance?v=logo%2F2");
  assert.equal(component.result.props.className, "clearlogo-plate");
  assert.equal(component.result.props["data-background"], "light");
  const image = component.result.props.children;
  assert.equal(image.type, env.load("components/ui/fade-in-image.tsx").FadeInImage);
  assert.equal(image.props.src, "/api/v1/shows/3/artwork/clearlogo?v=logo%2F2");
  assert.ok(image.props.fallback);
  component.unmount();
});
