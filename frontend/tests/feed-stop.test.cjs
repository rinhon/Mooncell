const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function setup(feeds = []) {
  let active;
  const modules = new Map(), runners = [], calls = [], toasts = [], invalidations = [];
  const queries = new Map([["feeds", feeds], ["shows", []]]);
  const env = { calls, toasts, invalidations, queries, respond: () => undefined };
  const slot = (create) => {
    const runner = active, index = runner.cursor++;
    return runner.slots[index] ??= create(runner);
  };
  const react = {
    useState(initial) {
      const runner = active, state = slot(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [state.value, (next) => {
        const value = typeof next === "function" ? next(state.value) : next;
        if (!Object.is(value, state.value)) { state.value = value; runner.dirty = true; }
      }];
    },
    useRef(initial) { return slot(() => ({ current: initial })); },
  };
  const queryClient = {
    setQueryData(key, updater) { queries.set(key[0], updater(queries.get(key[0]))); },
    invalidateQueries({ queryKey }) { invalidations.push([...queryKey]); return Promise.resolve(); },
  };
  function useMutation(options) {
    const runner = active;
    const state = slot(() => ({ isPending: false }));
    state.options = options;
    async function execute(variables) {
      state.isPending = true; state.variables = variables; runner.dirty = true;
      try {
        const result = await state.options.mutationFn(variables);
        await state.options.onSuccess?.(result, variables);
        return result;
      } catch (error) {
        await state.options.onError?.(error, variables);
        throw error;
      } finally {
        state.isPending = false; runner.dirty = true;
      }
    }
    return {
      isPending: state.isPending, variables: state.variables,
      mutateAsync: execute, mutate: (variables) => { void execute(variables).catch(() => {}); },
    };
  }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const primitives = new Proxy({}, { get: (_, name) => name });
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const exports = {};
    const compiled = ts.transpileModule(fs.readFileSync(require.resolve(`../src/${path}`), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    vm.runInNewContext(compiled, { exports, require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "@tanstack/react-query") return {
        useMutation, useQueryClient: () => queryClient,
        useQuery: ({ queryKey }) => ({ data: queries.get(queryKey[0]), isPending: false, isError: false }),
      };
      if (name === "@/lib/api") return { api(path, options) { calls.push({ path, options }); return env.respond(path, options); } };
      if (name === "@/components/ui/toast") return { useToast: () => (message, options) => toasts.push({ message, options }) };
      if (name === "@/components/feeds/batch-stop-menu") return load("components/feeds/batch-stop-menu.tsx");
      if (name === "lucide-react" || name.startsWith("@/components/")) return primitives;
      throw new Error(`Unexpected import: ${name}`);
    } }, { filename: path });
    modules.set(path, exports);
    return exports;
  }
  class Runner {
    constructor(component, props) { this.component = component; this.props = props; this.slots = []; runners.push(this); this.render(); }
    render() { active = this; this.cursor = 0; this.dirty = false; this.result = this.component(this.props); active = null; }
    change(props) { this.props = { ...this.props, ...props }; this.render(); }
  }
  function flush() {
    for (let count = 0; runners.some((runner) => runner.dirty); count++) {
      assert.ok(count < 20, "renders must settle");
      runners.forEach((runner) => { if (runner.dirty) runner.render(); });
    }
  }
  async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush(); } }
  return Object.assign(env, { load, Runner, flush, settle });
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== "object" || !("type" in tree)) return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...nodes(tree.props.children, predicate),
    ...nodes(tree.props.action, predicate),
  ];
}

const find = (tree, type) => nodes(tree, (node) => node.type === type);
const text = (node) => Array.isArray(node) ? node.map(text).join("") : node?.props ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
const button = (tree, label) => find(tree, "Button").find((node) => text(node) === label);
const checkboxes = (tree) => find(tree, "input").filter((node) => node.props.type === "checkbox");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const feed = (id, active = true) => ({ id, active, name: `订阅 ${id}`, kind: "mikan" });
const changedQueries = (env) => [...new Set(env.invalidations.map((key) => key[0]))].sort();
const relatedQueries = ["dashboard", "downloads", "feeds", "notifications", "reviews", "shows"];

test("single stop posts the selected ID, updates its cached feed and blocks more stops while pending", async () => {
  const feeds = [feed(1), feed(2), feed(3, false)], env = setup(feeds), request = deferred();
  env.respond = () => request.promise;
  const page = new env.Runner(env.load("pages/feeds.tsx").FeedsPage);
  find(page.result, "FeedCard")[2].props.onStop(feeds[2]);
  assert.equal(env.calls.length, 0);
  find(page.result, "FeedCard")[0].props.onStop(feeds[0]); env.flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].path, "/feeds/1/stop");
  assert.equal(env.calls[0].options.method, "POST");
  assert.equal(find(page.result, "FeedCard")[0].props.stopping, true);
  find(page.result, "FeedCard")[1].props.onStop(feeds[1]);
  assert.equal(env.calls.length, 1);
  request.resolve({ ...feeds[0], active: false, name: "后端确认的名称" });
  await env.settle();
  assert.equal(env.queries.get("feeds")[0].active, false);
  assert.equal(env.queries.get("feeds")[0].name, "后端确认的名称");
  assert.equal(env.queries.get("feeds")[1], feeds[1]);
  assert.deepEqual(changedQueries(env), relatedQueries);
  assert.equal(env.toasts.at(-1).message, "订阅已停止");
  assert.equal(env.toasts.at(-1).options.description, "后端确认的名称");
});

test("batch stop posts source_ids and merges the server result into cache", async () => {
  const feeds = [feed(1), feed(2), feed(3)], env = setup(feeds);
  env.respond = () => ({ items: [feed(1, false), feed(3, false)], stopped_count: 1, already_stopped_count: 1 });
  const page = new env.Runner(env.load("pages/feeds.tsx").FeedsPage);
  const menu = nodes(page.result, (node) => node.type?.name === "BatchStopMenu")[0];
  await menu.props.onStop([3, 1]); await env.settle();
  assert.equal(env.calls[0].path, "/feeds/batch-stop");
  assert.equal(env.calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(env.calls[0].options.body), { source_ids: [3, 1] });
  assert.deepEqual(env.queries.get("feeds").map((item) => item.active), [false, true, false]);
  assert.deepEqual(changedQueries(env), relatedQueries);
  assert.equal(env.toasts.at(-1).message, "已停止 1 个订阅");
  assert.equal(env.toasts.at(-1).options.description, "1 个订阅此前已停止。");
});

for (const batch of [false, true]) {
  test(`${batch ? "batch" : "single"} stop failure keeps cached state and reports the server error`, async () => {
    const feeds = [feed(1)], env = setup(feeds);
    env.respond = () => Promise.reject(new Error("连接已断开"));
    const page = new env.Runner(env.load("pages/feeds.tsx").FeedsPage);
    if (batch) {
      const menu = nodes(page.result, (node) => node.type?.name === "BatchStopMenu")[0];
      await assert.rejects(menu.props.onStop([1]), /连接已断开/);
    } else {
      find(page.result, "FeedCard")[0].props.onStop(feeds[0]);
    }
    await env.settle();
    assert.equal(env.queries.get("feeds"), feeds);
    assert.deepEqual(changedQueries(env), ["feeds"]);
    assert.equal(env.toasts.at(-1).message, batch ? "批量停止失败" : "停止订阅失败");
    assert.equal(env.toasts.at(-1).options.description, "连接已断开");
    assert.equal(env.toasts.at(-1).options.tone, "error");
  });
}

test("batch selection excludes stopped feeds, caps selection at 100 and removes unavailable IDs", () => {
  const feeds = [feed(1000, false), ...Array.from({ length: 102 }, (_, index) => feed(index + 1))];
  const env = setup(), menu = new env.Runner(env.load("components/feeds/batch-stop-menu.tsx").BatchStopMenu, {
    feeds, pending: false, onStop: async () => {},
  });
  find(menu.result, "DropdownMenuItem")[0].props.onSelect(); env.flush();
  assert.equal(find(menu.result, "Dialog")[0].props.open, true);
  assert.equal(checkboxes(menu.result).length, 102);
  button(menu.result, "选择前 100 个").props.onClick(); env.flush();
  assert.equal(checkboxes(menu.result).filter((node) => node.props.checked).length, 100);
  assert.equal(checkboxes(menu.result)[100].props.disabled, true);
  checkboxes(menu.result)[100].props.onChange(); env.flush();
  assert.equal(checkboxes(menu.result).filter((node) => node.props.checked).length, 100);
  checkboxes(menu.result)[0].props.onChange(); env.flush();
  checkboxes(menu.result)[100].props.onChange(); env.flush();
  assert.equal(checkboxes(menu.result)[100].props.checked, true);
  assert.equal(checkboxes(menu.result).filter((node) => node.props.checked).length, 100);
  menu.change({ feeds: feeds.map((item) => item.id === 2 ? { ...item, active: false } : item) });
  assert.equal(checkboxes(menu.result).filter((node) => node.props.checked).length, 99);
  button(menu.result, "清空").props.onClick(); env.flush();
  assert.equal(checkboxes(menu.result).filter((node) => node.props.checked).length, 0);
});

test("batch submit preserves selection after failure, blocks duplicate submits and closes only on success", async () => {
  const env = setup(), requests = [], stopped = [];
  const menu = new env.Runner(env.load("components/feeds/batch-stop-menu.tsx").BatchStopMenu, {
    feeds: [feed(1), feed(2)], pending: false,
    onStop(ids) { stopped.push([...ids]); const request = deferred(); requests.push(request); return request.promise; },
  });
  find(menu.result, "DropdownMenuItem")[0].props.onSelect(); env.flush();
  checkboxes(menu.result)[1].props.onChange(); env.flush();
  const submit = find(menu.result, "form")[0].props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} }); env.flush();
  assert.deepEqual(stopped, [[2]]);
  assert.equal(find(menu.result, "Button").find((node) => node.props.type === "submit").props.pending, true);
  find(menu.result, "Dialog")[0].props.onOpenChange(false); env.flush();
  assert.equal(find(menu.result, "Dialog")[0].props.open, true);
  let prevented = false;
  find(menu.result, "DialogContent")[0].props.onEscapeKeyDown({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  requests[0].reject(new Error("暂时失败")); await env.settle();
  assert.equal(find(menu.result, "Dialog")[0].props.open, true);
  assert.equal(checkboxes(menu.result)[1].props.checked, true);
  find(menu.result, "form")[0].props.onSubmit({ preventDefault() {} }); env.flush();
  assert.deepEqual(stopped, [[2], [2]]);
  requests[1].resolve({}); await env.settle();
  assert.equal(find(menu.result, "Dialog")[0].props.open, false);
  assert.equal(checkboxes(menu.result).some((node) => node.props.checked), false);
});

test("external pending and disabled state prevent batch changes and submission", async () => {
  const env = setup(), stopped = [];
  const menu = new env.Runner(env.load("components/feeds/batch-stop-menu.tsx").BatchStopMenu, {
    feeds: [feed(1), feed(2)], pending: false, onStop: async (ids) => stopped.push([...ids]),
  });
  find(menu.result, "DropdownMenuItem")[0].props.onSelect(); env.flush();
  checkboxes(menu.result)[0].props.onChange(); env.flush();
  for (const state of [{ pending: true }, { pending: false, disabled: true }]) {
    menu.change(state);
    checkboxes(menu.result)[1].props.onChange();
    find(menu.result, "form")[0].props.onSubmit({ preventDefault() {} }); await env.settle();
    assert.equal(checkboxes(menu.result)[0].props.checked, true);
    assert.equal(checkboxes(menu.result)[1].props.checked, false);
    assert.deepEqual(stopped, []);
  }
});
