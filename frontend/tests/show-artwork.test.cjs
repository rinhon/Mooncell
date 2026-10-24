const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/show-artwork.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(compiled, sandbox);
const { artworkUrl, artworkVersion, posterUrl } = sandbox.exports;

test("replacing a logo leaves poster and fanart URLs stable through subsequent scans", () => {
  const before = {
    id: 12, artwork_version: "scraped-before-scan", poster_ready: true,
    artwork_versions: { poster: "poster-a", fanart: "fanart-a", clearlogo: "logo-a" },
  };
  const uploaded = {
    ...before, artwork_version: "scraped-after-upload",
    artwork_versions: { ...before.artwork_versions, clearlogo: "logo-b" },
  };
  const scanned = { ...uploaded, artwork_version: "scraped-after-upload-new-scan" };
  for (const after of [uploaded, scanned]) {
    assert.equal(posterUrl(after), posterUrl(before));
    assert.equal(artworkUrl(after, "fanart"), artworkUrl(before, "fanart"));
    assert.notEqual(artworkUrl(after, "clearlogo"), artworkUrl(before, "clearlogo"));
  }
  assert.equal(artworkUrl(scanned, "clearlogo"), artworkUrl(uploaded, "clearlogo"));
  assert.equal(artworkVersion(scanned, "clearlogo"), "logo-b");
});

test("older API responses retain their existing URL version and escape it safely", () => {
  const show = { id: 2, artwork_version: "2026-10-24T12:30:00+08:00" };
  assert.equal(artworkUrl(show, "poster"), `/api/v1/shows/2/artwork/poster?v=${encodeURIComponent(show.artwork_version)}`);
  assert.equal(artworkUrl({ id: 2 }, "fanart"), "/api/v1/shows/2/artwork/fanart?v=");
});

test("poster fallback switches to the independently versioned local image when ready", () => {
  const show = {
    id: 3, poster_ready: false, poster_url: "https://example.test/poster.jpg",
    artwork_versions: { poster: "local-poster" },
  };
  assert.equal(posterUrl(show), show.poster_url);
  assert.equal(posterUrl({ ...show, poster_ready: true }), "/api/v1/shows/3/artwork/poster?v=local-poster");
  assert.equal(posterUrl({ ...show, poster_url: null }), undefined);
});
