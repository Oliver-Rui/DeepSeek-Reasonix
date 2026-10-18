import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NAME_LIMIT, buildRow, cleanName, rowOf, versionsOf } from "../lib/board.mjs";

// A document just big enough to see how a row is made: it records what was set as
// text and fails the moment anything is set as markup.
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this._text = "";
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(_) { throw new Error("a name was set as markup"); }
  set outerHTML(_) { throw new Error("a name was set as markup"); }
  append(...nodes) { this.children.push(...nodes); }
}
const doc = { createElement: (tag) => new El(tag) };
const texts = (el) => [el.textContent, ...el.children.flatMap(texts)];

const NASTY = {
  script: "<script>alert(1)</script>",
  img: '"><img src=x onerror=alert(1)>',
  rtl: "‮evil‬ name",
  isolate: "a⁦b⁩c‏d​e",
  controls: "tab\there\u0000nul\u0007bell\nline",
  long: "x".repeat(10000),
  longWide: "好".repeat(10000),
  empty: "   ​‮   ",
};

test("a name keeps its text but loses invisible and bidirectional controls", () => {
  assert.equal(cleanName(NASTY.rtl), "evil name");
  assert.equal(cleanName(NASTY.isolate), "abcde");
  assert.equal(cleanName(NASTY.controls), "tab herenulbell line");
  assert.equal(cleanName(NASTY.empty), "");
  assert.equal(cleanName(null), "");
});

test("markup in a name stays literal text", () => {
  assert.equal(cleanName(NASTY.script), "<script>alert(1)</script>");
  assert.equal(cleanName(NASTY.img), '"><img src=x onerror=alert(1)>');
});

test("an overlong name is cut to the limit in code points, with an ellipsis", () => {
  for (const key of ["long", "longWide"]) {
    const out = cleanName(NASTY[key]);
    assert.equal([...out].length, NAME_LIMIT, key);
    assert.ok(out.endsWith("…"), key);
  }
});

test("a row is made only with text, for every hostile name, ranked or not", () => {
  for (const [key, name] of Object.entries(NASTY)) {
    for (const ranked of [true, false]) {
      const entry = { displayName: name, credits: 3, rank: 1, releases: [{ version: "v2.1.0", count: 2 }] };
      const li = buildRow(entry, ranked, doc);
      const shown = texts(li).join("|");
      assert.ok(!/[‪-‮⁦-⁩]/u.test(shown), `${key}: a bidirectional control reached the page`);
      assert.ok(texts(li).every((t) => [...t].length <= NAME_LIMIT + 20), `${key}: an unbounded string reached the page`);
    }
  }
});

test("the row carries a place only in a release view, and the chips only in the all view", () => {
  const entry = { displayName: "Sample", credits: 2, rank: 3, releases: [{ version: "v2.2.0", count: 1 }, { version: "v2.1.0", count: 2 }, { version: "v2.0.0", count: 1 }, { version: "v1.9.0", count: 1 }] };
  assert.deepEqual(rowOf(entry, true), { rank: "3", name: "Sample", credits: 2, chips: [] });
  assert.deepEqual(rowOf(entry, false), { rank: null, name: "Sample", credits: 2, chips: ["v2.2.0", "v2.1.0 ×2", "v2.0.0"] });
});

test("versions are listed newest first, by number and not by text", () => {
  const entries = [{ releases: [{ version: "v2.9.0" }, { version: "v2.10.0" }] }, { releases: [{ version: "v2.2.0" }] }];
  assert.deepEqual(versionsOf(entries), ["v2.10.0", "v2.9.0", "v2.2.0"]);
});

test("nothing in the page script turns a name into markup", () => {
  for (const file of ["../scripts/board.js", "../lib/board.mjs", "../pages/community/board.astro"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|set:html/.test(source), `${file} writes markup`);
  }
});
