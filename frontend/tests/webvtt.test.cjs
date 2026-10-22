const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const compiled = ts.transpileModule(fs.readFileSync(require.resolve("../src/lib/player/webvtt.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(compiled, sandbox);
const { parseWebVtt } = sandbox.exports;

test("parses WebVTT timing, cue IDs, settings, BOM, CRLF and multiline text", () => {
  const cues = parseWebVtt("\uFEFFWEBVTT\r\n\r\ncue-1\r\n00:01.250 --> 00:03.500 align:start\r\n第一行\r\n第二行\r\n\r\n00:01:02.000 --> 00:01:04.000\r\n后续\r\n");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.25);
  assert.equal(cues[0].end, 3.5);
  assert.equal(cues[0].text, "第一行\n第二行");
  assert.equal(cues[1].start, 62);
});

test("excludes metadata and malformed cues; strips tags and decodes safe VTT text", () => {
  const cues = parseWebVtt(`WEBVTT

NOTE ignored comment
00:00.000 --> 00:01.000
not a cue

STYLE
::cue { color: red; }

00:99.000 --> 01:00.000
invalid seconds

00:03.000 --> 00:02.000
backward

00:01.000 --> 00:02.000
<v speaker><b>hello</b></v> &amp; &lt;script&gt;
`);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "hello & <script>");
});

test("rejects non-WebVTT responses instead of showing a login page as subtitles", () => {
  assert.throws(() => parseWebVtt("<!doctype html><title>Login</title>"), /WebVTT/);
});
