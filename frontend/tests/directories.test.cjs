const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { QueryClient, QueryObserver } = require("@tanstack/react-query");

const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/directories.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup(t) {
  const requests = [];
  let fail = false;
  const sandbox = { exports: {}, require(name) {
    if (name === "@tanstack/react-query") return require(name);
    if (name === "@/lib/api") return { api: async (url, { signal }) => {
      requests.push(url);
      assert.ok(signal instanceof AbortSignal);
      if (fail) throw new Error("目录暂时不可用");
      return { path: url, children: [{ name: "动画", path: "I:\\动画" }] };
    } };
    throw new Error(name);
  } };
  vm.runInNewContext(compiled, sandbox);
  const client = new QueryClient();
  const subscriptions = [];
  t.after(() => { subscriptions.forEach(stop => stop()); client.clear(); });
  const options = sandbox.exports.directoryQueryOptions;
  function observe(path, enabled = true) {
    const observer = new QueryObserver(client, { ...options(path), enabled });
    const unsubscribe = observer.subscribe(() => {});
    subscriptions.push(unsubscribe);
    return { observer, unsubscribe, setEnabled(next) { observer.setOptions({ ...options(path), enabled: next }); } };
  }
  return { client, requests, options, observe, setFailure(value) { fail = value; } };
}

async function idle(observer) {
  if (!observer.getCurrentResult().isFetching) return;
  await new Promise(resolve => {
    const stop = observer.subscribe(result => { if (!result.isFetching) { stop(); resolve(); } });
  });
}

test("reopening the picker and remounting a previously expanded path reuse fresh listings", async t => {
  const env = setup(t);
  const roots = env.observe(undefined, false);
  assert.equal(env.requests.length, 0);
  roots.setEnabled(true);
  await idle(roots.observer);
  const branch = env.observe("I:\\动画");
  await idle(branch.observer);
  const data = branch.observer.getCurrentResult().data;
  branch.unsubscribe();
  roots.setEnabled(false);
  roots.setEnabled(true);
  const reopened = env.observe("I:\\动画");
  await idle(reopened.observer);
  assert.equal(env.requests.length, 2);
  assert.equal(reopened.observer.getCurrentResult().data, data);
});

test("expired data is retained while closed and refreshed on the next expansion", async t => {
  const env = setup(t);
  const branch = env.observe("I:\\动画");
  await idle(branch.observer);
  branch.setEnabled(false);
  const key = env.options("I:\\动画").queryKey;
  env.client.setQueryData(key, branch.observer.getCurrentResult().data, { updatedAt: Date.now() - 5 * 60 * 1000 - 1 });
  assert.equal(env.requests.length, 1);
  branch.setEnabled(true);
  await idle(branch.observer);
  assert.equal(env.requests.length, 2);
});

test("manual refresh updates visible listings and defers collapsed paths until expanded", async t => {
  const env = setup(t);
  const roots = env.observe();
  const branch = env.observe("I:\\动画");
  await Promise.all([idle(roots.observer), idle(branch.observer)]);
  branch.setEnabled(false);
  await env.client.invalidateQueries({ queryKey: ["directories"] });
  assert.equal(env.requests.length, 3);
  assert.equal(env.requests.at(-1), "/filesystem/directories");
  branch.setEnabled(true);
  await idle(branch.observer);
  assert.equal(env.requests.length, 4);
  assert.ok(env.requests.at(-1).endsWith(`?path=${encodeURIComponent("I:\\动画")}`));
});

test("failed refresh retains the listing, avoids automatic retries and allows explicit retry", async t => {
  const env = setup(t);
  const roots = env.observe();
  await idle(roots.observer);
  const before = roots.observer.getCurrentResult().data;
  env.setFailure(true);
  await env.client.invalidateQueries({ queryKey: ["directories"] });
  assert.equal(env.requests.length, 2);
  assert.equal(roots.observer.getCurrentResult().data, before);
  assert.equal(roots.observer.getCurrentResult().error.message, "目录暂时不可用");
  env.setFailure(false);
  await roots.observer.refetch();
  assert.equal(env.requests.length, 3);
  assert.equal(roots.observer.getCurrentResult().error, null);
});
