// Whole-file syntax colours from a pinned local Prism. Git stays the source
// of every displayed character: a row is coloured only when the highlighted
// line joins back to exactly the patch text.

import Prism from "./vendor/prism.js";

const LIMIT = 128 * 1024;

const LANGS = {
  go: "go",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  md: "markdown",
  markdown: "markdown",
};

export function languageFor(path) {
  const ext = String(path).slice(String(path).lastIndexOf(".") + 1).toLowerCase();
  return LANGS[ext] ?? null;
}

export const untab = (text) => text.replace(/[^\t]*\t/g, (x) => x.slice(0, -1).padEnd((x.length - 1) - (x.length - 1) % 4 + 4));

function roleOf(type) {
  const t = String(type ?? "").toLowerCase();
  if (t.includes("comment")) return "com";
  if (t === "string" || t === "char" || t === "regex" || t === "template-string" || t === "attr-value" || t === "url") return "str";
  if (t === "number") return "num";
  if (t === "keyword" || t === "boolean" || t === "constant" || t === "builtin" || t === "important") return "kw";
  if (t === "class-name" || t === "type" || t === "namespace" || t === "function") return "type";
  if (t === "property" || t === "attr-name" || t === "key" || t === "variable") return "key";
  if (t === "title" || t === "bold" || t === "italic" || t === "strike") return "kw";
  return "text";
}

// One token tree per side. Newlines split tokens into per-line spans; tabs
// are expanded the same way the patch rows are.
export function tokenizeSide(text, lang) {
  const grammar = lang ? Prism.languages[lang] : null;
  if (!grammar || text == null) return null;
  if (typeof text !== "string" || text.length > LIMIT || text.includes("\0")) return null;
  const lines = [[]];
  let current = 0;
  const add = (chunk, role) => {
    const parts = chunk.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part) {
        const spans = lines[current];
        if (spans.length && spans[spans.length - 1][1] === role) spans[spans.length - 1][0] += part;
        else spans.push([part, role]);
      }
      if (i < parts.length - 1) {
        current++;
        lines.push([]);
      }
    }
  };
  const walk = (token, role) => {
    if (typeof token === "string") return add(token, role);
    if (Array.isArray(token)) return token.forEach((t) => walk(t, role));
    walk(token.content, token.type ? roleOf(token.type) : role);
  };
  walk(Prism.tokenize(untab(text), grammar), "text");
  return lines.map((spans) => spans.map(([t, r]) => [t.replace(/\r$/, ""), r]));
}

// Colour rows from the two complete sides. A mismatch or missing side leaves
// that row plain; text is never taken from the highlighter.
export function colorRows(rows, { oldText = null, newText = null, oldLang = null, newLang = null } = {}) {
  const oldLines = oldText == null ? null : tokenizeSide(oldText, oldLang);
  const newLines = newText == null ? null : tokenizeSide(newText, newLang);
  let coloured = 0;
  for (const row of rows) {
    if (row.m === undefined) continue;
    const plain = [[row.m, null]];
    const lines = row.k === "del" ? oldLines : newLines;
    const at = row.k === "del" ? row.o : row.n;
    const spans = lines && at ? lines[at - 1] : null;
    if (!spans || spans.map(([t]) => t).join("") !== row.m) {
      row.code = plain;
      continue;
    }
    row.code = spans;
    coloured++;
  }
  return coloured;
}

export { LIMIT };
