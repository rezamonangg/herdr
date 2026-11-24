// Native branch review: changed files on the left, one file's coloured diff
// on the right. Colours come from gitview's local diff engine when it is
// installed; without it the same rows fall back to plain text. Local only:
// no fetch, no GitHub calls.

import { View, div } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { appHome, checking, closeOverlay, exec, focused, panes, props, readTextFile, run, setShared, settings, shared, spaces, theme } from "herdr";

const PROBES = ["origin/main", "origin/master", "origin/next", "origin/develop", "master", "develop"];
const BASE_KEY = "branch-review.base";
const TREE_WIDTH = 300;
const ROW = 18;

// ---- git and engine --------------------------------------------------------

function tokens(buf) {
  const out = [];
  let at = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== "\0") continue;
    out.push(buf.slice(at, i));
    at = i + 1;
  }
  if (at < buf.length) out.push(buf.slice(at));
  return out;
}

export function parseNameStatus(buf) {
  const tok = tokens(buf);
  const out = [];
  for (let i = 0; i < tok.length; ) {
    const status = tok[i++];
    if (!status) continue;
    if (status[0] === "R" || status[0] === "C") out.push({ path: tok[i + 1], orig: tok[i], letter: status[0] }), (i += 2);
    else out.push({ path: tok[i++], orig: null, letter: status[0] });
  }
  return out;
}

export function parseNumstat(buf) {
  const tok = tokens(buf);
  const out = new Map();
  for (let i = 0; i < tok.length; ) {
    const line = tok[i++];
    if (!line) continue;
    const a = line.indexOf("\t");
    const b = line.indexOf("\t", a + 1);
    const add = line.slice(0, a);
    const del = line.slice(a + 1, b);
    let path = line.slice(b + 1);
    if (!path) (i += 1), (path = tok[i++]);
    out.set(path, { add: add === "-" ? null : Number(add), del: del === "-" ? null : Number(del) });
  }
  return out;
}

function kindOf(letter) {
  if (letter === "A") return "added";
  if (letter === "C") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  if (letter === "U") return "untracked";
  return "modified";
}

export function fileEntries(named, stats) {
  return named
    .map((n) => {
      const s = stats.get(n.path) ?? {};
      return { path: n.path, orig: n.orig ?? null, kind: kindOf(n.letter), letter: n.letter, add: s.add ?? null, del: s.del ?? null };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function rankRefs(refs, current, def) {
  const seen = new Set();
  const out = [];
  const add = (r) => {
    if (!r || r === "HEAD" || r.endsWith("/HEAD") || r === current || seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };
  add(def);
  for (const r of refs.filter((r) => r && !r.includes("/")).sort()) add(r);
  for (const r of refs.filter((r) => r && r.includes("/")).sort()) add(r);
  return out;
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push(file);
  }
  return root;
}

function count(node) {
  let n = node.files.length;
  for (const child of node.dirs.values()) n += count(child);
  return n;
}

export function treeRows(files, collapsed = new Set()) {
  const out = [];
  const emit = (node, depth, prefix) => {
    const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (let [name, child] of dirs) {
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [[inner, next]] = [...child.dirs.entries()];
        name = `${name}/${inner}`;
        child = next;
      }
      const path = `${prefix}${name}/`;
      const folded = collapsed.has(path);
      out.push({ k: "dir", path, name, depth, count: count(child), collapsed: folded });
      if (!folded) emit(child, depth + 1, path);
    }
    for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) out.push({ k: "file", file, depth });
  };
  emit(buildTree(files), 0, "");
  return out;
}

// ---- rows from the engine --------------------------------------------------

// The engine prefixes a marker and a gutter to each line. Drop both; the
// split view draws its own numbers, and unified uses the row's o/n.
export function codeSpans(s) {
  let i = 0;
  if (s?.[0]?.[0] === "▌") i = 1;
  if (s?.[i]?.[1] === "@gutter") i++;
  return (s ?? []).slice(i).filter(([text]) => text !== "");
}

// Changed lines paired left/right. Context is both sides; folds and the
// truncation marker stay full width.
export function splitRows(rows) {
  const out = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ k: "pair", d: dels[i] ?? null, a: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.k === "del") dels.push(row);
    else if (row.k === "add") adds.push(row);
    else if (row.k === "fold" || row.k === "cut") {
      flush();
      out.push(row);
    } else {
      flush();
      out.push({ k: "ctx", d: row, a: row });
    }
  }
  flush();
  return out;
}

export function parseUnified(text) {
  const all = String(text ?? "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return [];
  let o = 0;
  let n = 0;
  const rows = [];
  for (const raw of all.slice(first)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      rows.push({ k: "fold", text: raw });
      continue;
    }
    if (raw.startsWith("\\")) continue;
    const kind = raw[0];
    const text = raw.slice(1);
    if (kind === "-") rows.push({ k: "del", o: o++, n: null, m: text, s: [[text, null, null]] });
    else if (kind === "+") rows.push({ k: "add", o: null, n: n++, m: text, s: [[text, null, null]] });
    else if (kind === " ") rows.push({ k: "ctx", o: o++, n: n++, m: text, s: [[text, null, null]] });
  }
  return rows;
}

function color(c, t) {
  switch (c) {
    case "red": return t.ansi1;
    case "green": return t.ansi2;
    case "@ins": return `${t.ansi2}26`;
    case "@del": return `${t.ansi1}26`;
    case "@ins_emph": return `${t.ansi2}5c`;
    case "@del_emph": return `${t.ansi1}5c`;
    case "@gutter": return t.dim;
    case "@fold": return t.raised;
    case "@fold_fg": return t.muted;
    default: return c;
  }
}

const charWidth = (size) => size * 0.64;
const rowHeight = (size) => Math.ceil(size * 1.8);
const message = (e) => String(e?.message ?? e);
const isDark = (hex) => {
  const n = parseInt(String(hex).slice(1, 7), 16);
  if (Number.isNaN(n)) return true;
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
};

let config;
async function engine(args) {
  if (config === undefined) {
    const text = await readTextFile(`${appHome()}/mods/gitview/config.json`);
    config = text ? JSON.parse(text) : null;
    if (!config?.bin) throw new Error("gitview's engine is not installed");
  }
  const env = ["GITVIEW_HOST=app", `HERDR_APP_HOME=${appHome()}`];
  if (config.herdr_app) env.push(`GITVIEW_HERDR_APP=${config.herdr_app}`);
  if (config.hc) env.push(`GITVIEW_HC=${config.hc}`);
  const r = await exec("/usr/bin/env", [...env, config.bin, "json", ...args]);
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* reported below */ }
  if (r.code !== 0 || out?.error) throw new Error(out?.error ?? (r.stderr || r.stdout || `exit ${r.code}`).trim());
  return out;
}

// ---- where -----------------------------------------------------------------

function location(keep) {
  const f = focused();
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs.find((t) => t.active)?.id ?? f?.tab ?? null;
  const pane =
    panes().find((p) => p.tab === tab && p.pane === f?.pane) ??
    panes().find((p) => p.tab === tab && p.terminal && p.cwd) ??
    panes().find((p) => p.terminal && p.cwd && space?.tabs.some((t) => t.id === p.tab));
  if (keep && keep.tab === tab && pane && !pane.terminal) return keep;
  return { cwd: pane?.cwd || space?.folder || f?.cwd || null, on: space?.machine ?? null, space: space?.id ?? null, tab };
}

function cwdCandidates(loc) {
  const out = [];
  const add = (cwd) => { if (cwd && !out.includes(cwd)) out.push(cwd); };
  add(loc.cwd);
  const space = spaces().find((s) => s.id === loc.space);
  const live = panes().filter((p) => p.terminal && p.cwd);
  for (const p of live) if (p.tab === loc.tab) add(p.cwd);
  for (const p of live) if (space?.tabs.some((t) => t.id === p.tab)) add(p.cwd);
  add(space?.folder);
  return out;
}

async function pickRepo(loc) {
  for (const cwd of cwdCandidates(loc)) {
    try {
      const r = await git(["rev-parse", "--show-toplevel"], { cwd, on: loc.on });
      if (r.code === 0 && r.stdout.trim()) return { cwd, root: r.stdout.trim() };
    } catch { /* next */ }
  }
  return null;
}

function savedBase(key) { return (shared(BASE_KEY) ?? {})[key] ?? null; }
function rememberBase(key, label) {
  const all = { ...(shared(BASE_KEY) ?? {}) };
  delete all[key];
  all[key] = label;
  setShared(BASE_KEY, Object.fromEntries(Object.entries(all).slice(-20)));
}

const keyOf = (loc) => JSON.stringify([loc.cwd, loc.on ?? null, loc.tab ?? null]);

async function git(args, { cwd, on }) {
  try { return await exec("/usr/bin/git", args, { cwd, on: on ?? undefined }); }
  catch { return exec("git", args, { cwd, on: on ?? undefined }); }
}
async function gitText(args, ctx) {
  const r = await git(args, ctx);
  return r.code === 0 ? r.stdout.trim() : "";
}
async function detectBase(ctx) {
  const sym = await gitText(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], ctx);
  if (sym) return sym;
  for (const ref of PROBES) if (await gitText(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], ctx)) return ref;
  return null;
}

const letterColor = (t, letter) =>
  letter === "A" || letter === "U" ? t.ansi2 : letter === "D" ? t.ansi1 : letter === "R" ? t.ansi4 : t.ansi3;

// ---- view ------------------------------------------------------------------

export default class BranchReview extends View {
  init(_props, cx) {
    // The same mod is the key's 2×2 launcher and the tab's content. Opened
    // as the launcher, it shows the tab (or closes it) and draws nothing.
    const overlay = props()?.overlay;
    if (overlay) {
      this.launcher = true;
      const space = spaces().find((s) => s.active);
      const mine = space && panes().find((p) => p.mod === "branch-review" && space.tabs.some((t) => t.id === p.tab));
      const current = focused()?.tab;
      if (mine && mine.tab === current) run("tab.close", { id: mine.tab, confirmed: true });
      else if (mine) run("tab.select", { id: mine.tab });
      else run("tab.new", { name: "branch review", mod: "branch-review" });
      closeOverlay(overlay);
      return;
    }
    this.handle = cx.focus_handle();
    this.files = [];
    this.tree = [];
    this.refs = [];
    this.base = null;
    this.defaultBase = null;
    this.where = null;
    this.branch = null;
    this.collapsed = new Set();
    this.sel = null;
    this.rows = [];
    this.diffMode = "split";
    this.diffNote = null;
    this.diffLoading = false;
    this.diffSeq = 0;
    this.cache = new Map();
    this.displayRows = null;
    this.displayFor = null;
    this.displayMode = null;
    this.displayLongest = 0;
    this.ctx = null;
    this.loading = false;
    this.error = null;
    this.flash = null;
    this.choosing = false;
    this.starting = false;
    this.wantKey = null;
    if (!checking()) this.kick(cx);
  }

  kick(cx, opts) {
    if (this.loading || this.starting) return;
    this.starting = true;
    return cx.spawn(async (cx) => {
      try { await this.load(cx, opts); } finally { this.starting = false; }
    });
  }

  async load(cx, { base } = {}) {
    const loc = location(this.ctx);
    if (!loc.cwd) {
      this.error = "No folder";
      this.reset(cx);
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const picked = await pickRepo(loc);
      if (!picked) {
        this.reset(cx);
        this.error = "Not a git repository";
        return;
      }
      const ctx = { cwd: picked.cwd, on: loc.on };
      const root = picked.root;
      const moved = this.ctx?.cwd !== picked.cwd || this.ctx?.on !== loc.on;
      this.ctx = { ...loc, cwd: picked.cwd };
      this.wantKey = keyOf(this.ctx);
      if (moved) {
        this.files = [];
        this.where = null;
        this.sel = null;
        this.cache.clear();
      }
      const [head, branch, raw] = await Promise.all([
        gitText(["rev-parse", "HEAD"], ctx),
        gitText(["rev-parse", "--abbrev-ref", "HEAD"], ctx),
        git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], ctx),
      ]);
      const refs = raw.stdout.split("\n").filter(Boolean);
      const def = PROBES.find((r) => refs.includes(r)) ?? (await detectBase(ctx));
      this.defaultBase = def;
      this.refs = rankRefs(refs, branch || "HEAD", def);
      this.branch = branch || "HEAD";

      const key = `${loc.on ?? ""}:${root}`;
      let chosen = base ?? savedBase(key);
      if (chosen && !(await gitText(["rev-parse", "--verify", "--quiet", `${chosen}^{commit}`], ctx))) {
        this.flash = `Base ${chosen} not found — choose another branch.`;
        chosen = null;
      }
      const target = chosen ?? def;
      if (!target) {
        this.reset(cx);
        this.error = "No base branch found — choose one.";
        return;
      }
      this.base = target;
      const mb = await gitText(["merge-base", target, "HEAD"], ctx);
      if (!mb) {
        this.reset(cx);
        this.error = `No common ancestor with ${target}.`;
        return;
      }
      this.where = { root, on: loc.on ?? null, base: { label: target, merge_base: mb } };

      const [named, stats, others] = await Promise.all([
        git(["diff", "--name-status", "-z", "-M", mb, "--"], ctx),
        git(["diff", "--numstat", "-z", "-M", mb, "--"], ctx),
        git(["ls-files", "-z", "--others", "--exclude-standard"], ctx),
      ]);
      if (named.code !== 0) throw new Error((named.stderr || named.stdout || "git diff failed").trim());
      const files = fileEntries(parseNameStatus(named.stdout), parseNumstat(stats.stdout));
      const untracked = [...new Set(tokens(others.stdout).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      for (const path of untracked) if (!files.some((f) => f.path === path)) files.push({ path, orig: null, kind: "untracked", letter: "U", add: null, del: null });
      files.sort((a, b) => a.path.localeCompare(b.path));
      this.files = files;
      this.tree = treeRows(files, this.collapsed);
      this.cache.clear();
      this.error = null;
      if (!files.some((f) => f.path === this.sel)) this.sel = files[0]?.path ?? null;
      this.loading = false;
      cx.notify();
      if (this.sel) await this.loadDiff(cx, files.find((f) => f.path === this.sel));
      else this.rows = [];
    } catch (e) {
      this.error = message(e);
    } finally {
      this.loading = false;
      cx.notify();
    }
  }

  reset(cx) {
    this.files = [];
    this.tree = [];
    this.where = null;
    this.rows = [];
    this.diffSeq++;
    this.loading = false;
    cx.notify();
  }

  reload(cx) { this.cache.clear(); this.kick(cx); }

  choose(cx, label) {
    this.choosing = false;
    if (!this.where || label === this.base) return;
    rememberBase(`${this.ctx?.on ?? ""}:${this.where.root}`, label);
    return this.kick(cx, { base: label });
  }

  async loadDiff(cx, file) {
    if (!file || !this.where) return;
    const token = ++this.diffSeq;
    this.diffLoading = true;
    this.diffNote = null;
    const cacheKey = `${file.path}|${file.kind}|${file.orig ?? ""}|${this.where.base.merge_base}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (this.sel === file.path) {
        this.rows = cached.rows;
        this.diffLoading = false;
        cx.notify();
      }
      return;
    }
    this.rows = [];
    cx.notify();
    const dark = isDark(theme().background);
    try {
      const args = ["diff", "--repo", this.where.root, "--root", "--path", file.path, "--kind", file.kind, "--theme", dark ? "dark" : "light", "--merge-base", this.where.base.merge_base, "--base", this.where.base.label];
      if (file.orig) args.push("--orig", file.orig);
      let rows;
      let hash = null;
      try {
        const out = await engine(args);
        rows = out.rows ?? [];
        hash = out.hash ?? null;
        if (out.binary) this.diffNote = "Binary file";
        if (out.empty && !rows.length) this.diffNote = "No text changes";
        if (out.truncated) rows = [...rows, { k: "cut", n: rows.length }];
      } catch (e) {
        // No engine: the same view in plain text, no syntax colours.
        const ctx = { cwd: this.ctx.cwd, on: this.ctx.on };
        const paths = file.orig ? ["--", file.path, file.orig] : ["--", file.path];
        const r = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "-M", this.where.base.merge_base, ...paths], ctx);
        if (r.code !== 0) throw new Error(message(e));
        rows = parseUnified(r.stdout);
        if (!rows.length) this.diffNote = file.add === null && file.del === null ? "Binary file" : "No text changes";
      }
      if (token !== this.diffSeq) return;
      this.rows = rows;
      this.cache.set(cacheKey, { rows, hash });
    } catch (e) {
      if (token === this.diffSeq) {
        this.diffNote = message(e);
        this.rows = [];
      }
    } finally {
      if (token === this.diffSeq) {
        this.diffLoading = false;
        cx.notify();
      }
    }
  }

  pick(cx, file) {
    if (!file) return;
    this.sel = file.path;
    return this.loadDiff(cx, file);
  }

  // Rows and their plain-text width are expensive to derive; do it when the
  // diff or mode changes, not on every hover/click render.
  display() {
    if (this.displayFor === this.rows && this.displayMode === this.diffMode) return this.displayRows;
    this.displayFor = this.rows;
    this.displayMode = this.diffMode;
    const rows = this.diffMode === "split" ? splitRows(this.rows) : this.rows;
    let longest = 0;
    const prep = (row) => {
      if (!row) return;
      if (!row.code) row.code = codeSpans(row.s);
      longest = Math.max(longest, row.code.reduce((n, [text]) => n + text.length, 0));
    };
    for (const row of rows) {
      if (row.k === "pair") { prep(row.d); prep(row.a); }
      else if (row.k === "ctx") prep(row.d);
      else if (row.k === "fold") longest = Math.max(longest, (row.text ?? "").length);
      else prep(row);
    }
    this.displayRows = rows;
    this.displayLongest = longest;
    return rows;
  }

  key(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return false;
    if (e.key !== "escape") return false;
    if (this.choosing) this.choosing = false;
    else return false;
    return true;
  }

  // ---- drawing -------------------------------------------------------------

  render(cx) {
    if (this.launcher) return div();
    const t = theme();
    const loc = location(this.ctx);
    if (!this.loading && loc.tab && loc.cwd) {
      const k = keyOf(loc);
      if (k !== this.wantKey) this.kick(cx);
    }
    const totals = this.files.reduce((n, f) => ({ add: n.add + (f.add ?? 0), del: n.del + (f.del ?? 0) }), { add: 0, del: 0 });
    const file = this.files.find((f) => f.path === this.sel);
    const size = settings().font_size;
    const rows = this.display();
    const longest = this.displayLongest;
    const width = this.diffMode === "split" ? Math.max(500, longest * charWidth(size) * 2 + 90) : Math.max(320, longest * charWidth(size) + 70);
    const listId = `br-diff-${hash(`${this.sel}:${this.diffMode}`)}`;

    return v_flex()
      .id("branch-review")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .on_key_down((e, cx) => {
        if (!this.key(e, cx)) return;
        this.flash = null;
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.header(t, totals, cx))
      .child(
        h_flex().flex_1().min_h(0).items_stretch()
          .child(this.sidebar(t, cx))
          .child(
            v_flex().flex_1().min_w(0).min_h(0).h_full()
              .child(this.diffHeader(t, file, cx))
              .child(
                div().flex_1().min_h(0).h_full().relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(size)
                  .when(!file, (e) => e.child(div().p(12).text_size(12).text_color(t.dim).child(this.loading ? "Loading…" : this.error ?? "No changed files.")))
                  .when(Boolean(file), (e) =>
                    e
                      .child(
                        div().id(`${listId}-x`).size_full().overflow_x_scrollbar()
                          .child(
                            div().w_full().min_w(width).h_full().child(
                              v_virtual_list(listId, rows.length, rowHeight(size), (i) => String(i),
                                (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, size))).size_full()
                            )
                          )
                      )
                      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0())
                      .when(!rows.length, (x) => x.child(div().absolute().top(0).left_0().p(12).text_size(12).text_color(t.dim).child(this.diffLoading ? "Loading diff…" : this.diffNote ?? "No text changes")))
                  )
              )
          )
      )
      .child(this.footer(t));
  }

  header(t, totals, cx) {
    return h_flex()
      .h(32)
      .flex_none()
      .px(10)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(div().flex_none().font_semibold().child("Changes"))
      .child(
        h_flex()
          .id("br-base")
          .flex_none()
          .h(20)
          .px(6)
          .gap(4)
          .items_center()
          .rounded(4)
          .bg(t.raised)
          .text_size(11)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Base branch")
          .on_click((_e, cx) => { this.choosing = !this.choosing; cx.stop_propagation(); cx.notify(); })
          .child(div().child("vs"))
          .child(div().min_w(0).max_w(150).truncate().text_color(t.foreground).child(this.base ?? "…"))
      )
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.branch ?? ""))
      .child(
        h_flex().flex_none().gap(6).text_size(11).text_color(t.dim)
          .when(totals.add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${totals.add}`)))
          .when(totals.del > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${totals.del}`)))
          .child(div().child(String(this.files.length)))
      )
      .child(
        div()
          .id("br-refresh")
          .size(22)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .cursor_pointer()
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Reload")
          .on_click((_e, cx) => { cx.stop_propagation(); this.reload(cx); cx.notify(); })
          .child(this.loading ? "…" : "↺")
      );
  }

  sidebar(t, cx) {
    const rows = this.choosing ? [] : this.tree;
    return v_flex()
      .w(TREE_WIDTH)
      .flex_none()
      .h_full()
      .min_h(0)
      .border_r(1)
      .border_color(t.border)
      .relative()
      .when(this.choosing, (e) => e.child(v_flex().absolute().inset_0().p(4).overflow_y_scroll().children(this.baseRows(t, cx))))
      .when(!this.choosing, (e) =>
        e.child(
          v_flex().id("br-tree").absolute().inset_0().p(4).overflow_y_scrollbar().mode("always")
            .children(rows.map((row) => this.treeRow(row, t, cx)))
            .when(!rows.length, (x) => x.child(div().p(6).text_size(12).text_color(t.dim).child(this.loading ? "Loading…" : this.error ?? (this.where ? "No changes." : "No repository."))))
        )
      );
  }

  treeRow(row, t, cx) {
    if (row.k === "dir") {
      return h_flex()
        .id(`br-dir-${row.path}`)
        .h(24)
        .flex_none()
        .gap(4)
        .items_center()
        .rounded(4)
        .pl(4 + row.depth * 12)
        .pr(6)
        .hover((s) => s.bg(t.hover))
        .cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); if (this.collapsed.has(row.path)) this.collapsed.delete(row.path); else this.collapsed.add(row.path); this.tree = treeRows(this.files, this.collapsed); cx.notify(); })
        .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(row.collapsed ? "▸" : "▾"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(row.name))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(String(row.count)));
    }
    const f = row.file;
    const at = f.path.lastIndexOf("/");
    const name = at < 0 ? f.path : f.path.slice(at + 1);
    return h_flex()
      .id(`br-file-${f.path}`)
      .h(24)
      .flex_none()
      .gap(6)
      .items_center()
      .rounded(4)
      .pl(18 + row.depth * 12)
      .pr(6)
      .when(f.path === this.sel, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .cursor_pointer()
      .tooltip(f.path)
      .on_click((_e, cx) => { cx.stop_propagation(); this.pick(cx, f); cx.notify(); })
      .child(div().w(10).flex_none().font_bold().text_size(10).text_color(letterColor(t, f.letter)).child(f.letter))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .when(f.add !== null && f.add > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del !== null && f.del > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi1).child(`−${f.del}`)));
  }

  baseRows(t, cx) {
    return this.refs.map((ref) => {
      const isDefault = ref === this.defaultBase;
      return h_flex()
        .id(`br-ref-${ref}`)
        .h(24)
        .flex_none()
        .px(6)
        .gap(6)
        .items_center()
        .rounded(4)
        .when(ref === this.base, (e) => e.bg(t.raised).text_color(t.foreground))
        .hover((s) => s.bg(t.hover))
        .cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); this.choose(cx, ref); cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().child(ref))
        .when(isDefault, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("default")));
    });
  }

  diffHeader(t, file, cx) {
    if (!file) return div().h(28).flex_none().border_b(1).border_color(t.border);
    return h_flex()
      .h(28)
      .flex_none()
      .px(8)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(div().w(10).flex_none().font_bold().text_size(10).text_color(letterColor(t, file.letter)).child(file.letter))
      .child(div().min_w(0).truncate().child(file.path))
      .when(file.add !== null && file.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${file.add}`)))
      .when(file.del !== null && file.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${file.del}`)))
      .child(div().flex_1())
      .child(
        h_flex().flex_none().h(19).rounded(4).bg(t.raised).text_size(10).overflow_hidden()
          .child(this.modeButton(t, "split", "Split", cx))
          .child(this.modeButton(t, "unified", "Unified", cx))
      );
  }

  modeButton(t, mode, label, cx) {
    return div()
      .id(`br-mode-${mode}`)
      .h_full()
      .px(7)
      .flex()
      .items_center()
      .cursor_pointer()
      .when(this.diffMode === mode, (e) => e.bg(t.selected).text_color(t.foreground))
      .when(this.diffMode !== mode, (e) => e.text_color(t.dim))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.diffMode = mode; cx.notify(); })
      .child(label);
  }

  diffRow(row, t, size) {
    const h = rowHeight(size);
    if (row.k === "fold") {
      const text = row.text ?? codeSpans(row.s).map(([x]) => x).join("");
      return div().w_full().h(h).flex_none().px(8).truncate().bg(t.raised).text_size(size - 2).text_color(t.dim).child(text);
    }
    if (row.k === "cut") {
      return div().w_full().h(h).flex_none().px(8).text_size(size - 2).text_color(t.dim).child("diff cut");
    }
    if (this.diffMode === "split") {
      return h_flex().w_full().h(h).flex_none()
        .child(this.cell(t, size, row.d, row.d?.o, row.d ? "del" : null))
        .child(div().w(1).flex_none().bg(t.border))
        .child(this.cell(t, size, row.a, row.a?.n, row.a ? "add" : null));
    }
    const one = row.k === "pair" ? row.d ?? row.a : row.k === "ctx" ? row.d : row;
    const number = one?.k === "del" ? one.o : one?.n;
    return h_flex()
      .w_full()
      .h(h)
      .flex_none()
      .gap(6)
      .when(one?.k === "add", (e) => e.bg(`${t.ansi2}18`))
      .when(one?.k === "del", (e) => e.bg(`${t.ansi1}18`))
      .child(div().w(this.gutter(size)).flex_none().pr(2).text_right().text_color(t.dim).child(number == null ? "" : String(number)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().children(this.spans(one, t)));
  }

  cell(t, size, row, number, tint) {
    return h_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .gap(4)
      .when(tint === "add", (e) => e.bg(`${t.ansi2}18`))
      .when(tint === "del", (e) => e.bg(`${t.ansi1}18`))
      .child(div().w(this.gutter(size)).flex_none().pr(2).text_right().text_color(t.dim).child(number == null ? "" : String(number)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().children(this.spans(row, t)));
  }

  spans(row, t) {
    return (row?.code ?? codeSpans(row?.s)).map(([text, fg, bg]) =>
      div().flex_none()
        .when(Boolean(fg), (e) => e.text_color(color(fg, t)))
        .when(Boolean(bg), (e) => e.bg(color(bg, t)))
        .child(text.replace(/ /g, "\u00a0"))
    );
  }

  gutter(size) {
    return Math.ceil(4 * charWidth(size));
  }

  footer(t) {
    const said = this.flash ?? (this.choosing ? "click a branch · Escape closes" : "click a file · Split / Unified · ↺ reloads");
    return h_flex()
      .h(24)
      .flex_none()
      .px(10)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .text_size(11)
      .text_color(this.flash ? t.ansi1 : t.dim)
      .child(div().min_w(0).truncate().child(said));
  }
}

const hash = (text) => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
