const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/show-playback.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(compiled, sandbox);
const { playbackTarget } = sandbox.exports;

const earlier = "2026-10-24T10:00:00Z";
const later = "2026-10-24T11:00:00Z";
const latest = "2026-10-24T12:00:00Z";
function episode(number, progress = null, overrides = {}) {
  return {
    media_id: `episode-${number}`, episode_start: number, filename: `Episode ${number}.mkv`,
    progress, ...overrides,
  };
}
function watched(position, updated_at, completed = false) {
  return { position, duration: 1440, completed, updated_at };
}
function series() { return Array.from({ length: 12 }, (_, index) => episode(index + 1)); }

test("continue watching follows the most recently watched tenth episode instead of a first-episode remainder", () => {
  const items = series();
  items[0].progress = watched(80, earlier);
  items[9].progress = watched(700, later);
  const target = playbackTarget(items, false);
  assert.equal(target.item, items[9]);
  assert.equal(target.label, "继续观看 第 10 集");
});

test("revisiting an earlier episode takes priority over a higher episode number", () => {
  const items = series();
  items[0].progress = watched(80, latest);
  items[9].progress = watched(700, later);
  assert.equal(playbackTarget(items, false).item, items[0]);
});

test("finishing the latest episode selects the following unwatched episode instead of an old remainder", () => {
  const items = series();
  items[0].progress = watched(80, earlier);
  items[9].progress = watched(1440, later, true);
  const target = playbackTarget(items, false);
  assert.equal(target.item, items[10]);
  assert.equal(target.label, "播放第 11 集");
});

test("the next episode skips completed and unavailable files and can continue its saved position", () => {
  const items = series();
  items[7].progress = watched(1440, latest, true);
  items[8].progress = watched(1440, earlier, true);
  items[9].rename_pending = true;
  items[10].media_id = null;
  items[11].progress = watched(200, later);
  const target = playbackTarget(items, false);
  assert.equal(target.item, items[11]);
  assert.equal(target.label, "继续观看 第 12 集");
});

test("without a following unwatched episode the most recently completed episode is replayed", () => {
  const items = [episode(1, watched(70, earlier)), episode(10, watched(1440, latest, true))];
  const target = playbackTarget(items, false);
  assert.equal(target.item, items[1]);
  assert.equal(target.label, "播放第 10 集");
});

test("a fully watched series replays the most recently watched episode", () => {
  const items = [episode(1, watched(1440, earlier, true)), episode(2, watched(1440, later, true))];
  assert.equal(playbackTarget(items, false).item, items[1]);
});

test("no watching history starts with the first playable episode and ignores zero-position records", () => {
  const items = series();
  items[0].media_id = null;
  items[9].progress = watched(0, latest);
  const target = playbackTarget(items, false);
  assert.equal(target.item, items[1]);
  assert.equal(target.label, "播放第 2 集");
});

test("newer records for renaming or unregistered files cannot become the playback target", () => {
  const items = [
    episode(1, watched(80, earlier)),
    episode(10, watched(700, later), { rename_pending: true }),
    episode(11, watched(700, latest), { media_id: null }),
  ];
  assert.equal(playbackTarget(items, false).item, items[0]);
  assert.equal(playbackTarget([], false), null);
  assert.equal(playbackTarget(items.slice(1), false), null);
});

test("missing, invalid and tied timestamps preserve stable list order", () => {
  for (const stamps of [[undefined, null], ["invalid", ""], [earlier, earlier]]) {
    const items = [episode(1, watched(20, stamps[0])), episode(10, watched(40, stamps[1]))];
    assert.equal(playbackTarget(items, false).item, items[0]);
  }
});

test("a valid timestamp takes precedence over undated legacy records", () => {
  const items = [episode(1, watched(20)), episode(10, watched(40, earlier))];
  assert.equal(playbackTarget(items, false).item, items[1]);
});

test("movie and unknown-episode labels remain supported", () => {
  const movie = episode(null);
  assert.equal(playbackTarget([movie], true).label, "播放影片");
  movie.progress = watched(30, earlier);
  assert.equal(playbackTarget([movie], true).label, "继续观看");
  assert.equal(playbackTarget([episode(null)], false).label, "播放视频");
  assert.equal(playbackTarget([movie], false).label, "继续观看 视频");
});
