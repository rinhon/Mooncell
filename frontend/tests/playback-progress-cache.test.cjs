const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { QueryClient, QueryObserver } = require("@tanstack/react-query");

const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/player/progress-cache.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(compiled, sandbox);
const { syncPlaybackProgress } = sandbox.exports;
const key = ["shows", "library", 7];
const older = { position: 120, duration: 1440, completed: false, updated_at: "2026-10-24T11:00:00Z" };
const latest = { position: 615, duration: 1440, completed: false, updated_at: "2026-10-24T12:00:00Z" };
const library = (progress = older) => ({
  available: true, partial: false, total: 2,
  seasons: [{ season: 1, items: [
    { media_id: "episode-1", progress: older },
    { media_id: "episode-10", progress },
  ] }],
});

test("progress saved during the return request cancels stale data and refetches the committed library", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(key, library());
  let resolveOld, resolveFresh, aborted = false, calls = 0;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: ({ signal }) => {
      calls++;
      if (calls === 1) {
        signal.addEventListener("abort", () => { aborted = true; });
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return new Promise((resolve) => { resolveFresh = resolve; });
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const saving = syncPlaybackProgress(client, 7, "episode-10", latest);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(aborted, true);
    assert.equal(calls, 2, "the mounted detail page must refetch after the save completes");
    assert.equal(client.getQueryData(key).seasons[0].items[1].progress, latest);
    assert.equal(client.getQueryData(key).seasons[0].items[0].progress, older);
    resolveOld(library());
    resolveFresh(library(latest));
    await saving;
    assert.equal(client.getQueryData(key).seasons[0].items[1].progress.position, 615);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("a late older progress response cannot roll back a newer cached record", async () => {
  const client = new QueryClient();
  try {
    client.setQueryData(key, library(latest));
    await syncPlaybackProgress(client, 7, "episode-10", older);
    assert.equal(client.getQueryData(key).seasons[0].items[1].progress, latest);
    assert.equal(client.getQueryState(key).isInvalidated, true);
  } finally { client.clear(); }
});

test("saving without a cached library lets the next page fetch a complete library", async () => {
  const client = new QueryClient();
  try {
    await syncPlaybackProgress(client, 7, "episode-10", latest);
    assert.equal(client.getQueryData(key), undefined);
    const fetched = await client.fetchQuery({ queryKey: key, queryFn: () => library(latest) });
    assert.equal(fetched.seasons[0].items.length, 2);
    assert.equal(fetched.seasons[0].items[1].progress, latest);
  } finally { client.clear(); }
});
