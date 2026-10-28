const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/player/subtitle-preference.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(compiled, sandbox);
const { preferredChineseSubtitle } = sandbox.exports;

function track(id, language, title = null, overrides = {}) {
  return { id, language, title, codec: "srt", supported: true, url: `/subtitles/${id}`, reason: null, ...overrides };
}

test("simplified Chinese is preferred regardless of original subtitle order", () => {
  const tracks = [track("en", "eng"), track("generic", "zho"), track("tc", "zh-Hant"), track("sc", "zh-Hans")];
  assert.equal(preferredChineseSubtitle(tracks), "sc");
  assert.equal(preferredChineseSubtitle(tracks.toReversed()), "sc");
});

for (const language of ["zh-Hans", "zh-CN", "ZH_cn", "zh-SG", "cmn-Hans", "chs", "sc"]) {
  test(`language ${language} identifies simplified Chinese`, () => {
    assert.equal(preferredChineseSubtitle([track("tc", "zh-TW"), track("sc", language)]), "sc");
  });
}

for (const title of ["简体中文", "簡體中文", "简日双语", "CHS & ENG", "Simplified Chinese", "影片 S01E01.sc.srt", "影片 S01E01.zh-Hans.srt", "影片 S01E01.GB2312.srt"]) {
  test(`subtitle title ${title} identifies simplified Chinese`, () => {
    assert.equal(preferredChineseSubtitle([track("tc", "zho", "繁體中文"), track("sc", null, title)]), "sc");
  });
}

for (const language of ["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "cht", "tc"]) {
  test(`language ${language} identifies traditional Chinese when simplified is unavailable`, () => {
    assert.equal(preferredChineseSubtitle([track("en", "eng"), track("tc", language)]), "tc");
  });
}

for (const title of ["繁體中文", "繁体中文", "CHT", "Traditional Chinese", "影片 S01E01.tc.srt"]) {
  test(`subtitle title ${title} identifies traditional Chinese`, () => {
    assert.equal(preferredChineseSubtitle([track("jp", "jpn"), track("tc", null, title)]), "tc");
  });
}

test("generic Chinese tags and labels are used as a final Chinese fallback", () => {
  for (const language of ["zh", "chi", "zho", "cmn", "yue"])
    assert.equal(preferredChineseSubtitle([track("en", "eng"), track("zh", language)]), "zh");
  for (const title of ["中文字幕", "Chinese", "Mandarin"])
    assert.equal(preferredChineseSubtitle([track("en", "eng"), track("zh", null, title)]), "zh");
});

test("unavailable or unsupported simplified subtitles cannot hide usable Chinese subtitles", () => {
  const tracks = [track("sc-bitmap", "zh-Hans", null, { supported: false }), track("sc-no-url", "zh-CN", null, { url: null }), track("tc", "zh-Hant")];
  assert.equal(preferredChineseSubtitle(tracks), "tc");
});

test("without a playable Chinese track subtitles stay off instead of selecting another language", () => {
  assert.equal(preferredChineseSubtitle([track("en", "eng"), track("jp", "jpn"), track("unknown", null, "字幕轨 3"), track("sc-unavailable", "zh-Hans", null, { supported: false })]), "");
  assert.equal(preferredChineseSubtitle([]), "");
});

test("marker boundaries avoid treating unrelated titles as Chinese while equal choices remain stable", () => {
  assert.equal(preferredChineseSubtitle([track("english", "eng", "Scene subtitles"), track("jp", "jpn", "Main soundtrack")]), "");
  assert.equal(preferredChineseSubtitle([track("first", "zh-Hans"), track("second", "zh-CN")]), "first");
});

test("explicit script metadata takes precedence over conflicting title labels", () => {
  assert.equal(preferredChineseSubtitle([track("tc", "zh-Hant", "Simplified"), track("sc", "zh-Hans")]), "sc");
});
