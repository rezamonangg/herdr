// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.
//
// On top of that, GitHub (gh): each repo space's PR shows as a mark — checks
// failed red, running, passing green; merged purple; a bubble for comments not
// needing attention. A merged worktree asks to be deleted; comments stay docked and notify once. Beside
// each repo space's name, a down-arrow button runs git fetch + rebase on its
// branch, red with a count while it sits behind its upstream.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { commentCard } from "./dock.js";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, notify, props, nextCommand } from "herdr";

// Resolution is exposed on review threads, not on REST review comments. The
// budget comes back with the answer, free, so polling can stop before failing.
const REVIEW_THREADS = `query($owner:String!, $name:String!, $number:Int!, $endCursor:String) {
  rateLimit { remaining resetAt }
  repository(owner:$owner, name:$name) { pullRequest(number:$number) {
    reviewThreads(first:100, after:$endCursor) {
      nodes { isResolved comments(first:1) { nodes { databaseId } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;

// Cached PR numbers let one query per repo refresh several checkouts: gh's own
// branch lookup asks for 30 candidates and full commit history every time.
const BATCH = 10;
const STATUS = `number url state mergeable reviewDecision updatedAt headRefName
  author { login }
  commits(last:1) { nodes { commit { committedDate statusCheckRollup {
    contexts(first:100) {
      nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } }
      pageInfo { hasNextPage }
    }
  } } } }`;

function targetOf(url) {
  const m = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url ?? "");
  return m ? { host: m[1], repo: m[2] } : null;
}

// A batched PullRequest node in the shape readPR already reads (gh's JSON).
function fromBatch(node) {
  const first = node.commits?.nodes?.[0]?.commit;
  const roll = first?.statusCheckRollup?.contexts;
  return {
    number: node.number, url: node.url, state: node.state, mergeable: node.mergeable,
    reviewDecision: node.reviewDecision, updatedAt: node.updatedAt, author: node.author,
    commits: (node.commits?.nodes ?? []).map((n) => ({ committedDate: n?.commit?.committedDate })),
    statusCheckRollup: roll?.nodes ?? [],
    ciComplete: roll ? roll.pageInfo?.hasNextPage !== true : true,
  };
}

// Keep dock history separate from feedback that still needs attention.
function readPR(j, login) {
  // A legacy status context reports `state`; a check run reports `status` and
  // `conclusion`. Both shapes arrive in the same list.
  const roll = (j.statusCheckRollup ?? []).map((c) => c.conclusion ?? c.state ?? c.status);
  const fail = roll.some((c) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"].includes(c));
  const run = roll.some((c) => c == null || ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING"].includes(c));
  const resolved = new Map((j.reviewThreads ?? []).map(t => [t.comments?.nodes?.[0]?.databaseId, t.isResolved]));
  const comments = [
    ...(j.comments ?? []),
    ...(j.reviews ?? []).filter(r => r.body?.trim()).map(r => ({ ...r, createdAt: r.submittedAt })),
    ...(j.reviewComments ?? []).map(c => ({
      ...c, author: c.user, createdAt: c.created_at, url: c.html_url,
      resolved: resolved.get(c.in_reply_to_id ?? c.id) === true,
    })),
  ].filter(c => c.createdAt && c.author?.login && c.author.login !== login && c.author.login !== j.author?.login
    && c.author.type !== "Bot" && c.author.is_bot !== true && !/bot/i.test(c.author.login))
    .map(c => ({
      id: c.url || `${c.id ?? c.author.login}:${c.createdAt}`,
      at: c.createdAt, author: c.author.login, body: c.body?.slice(0, 300) ?? "",
      url: c.url || j.url,
      resolved: c.resolved === true,
    })).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  // Pending human comments: resolution or a newer commit removes them.
  const pushed = (j.commits ?? []).map(c => c.committedDate ?? "").sort().pop() ?? "";
  const attentionIds = (j.state === "OPEN" ? comments.filter(c => !c.resolved && c.at > pushed) : []).map(c => c.id);
  // reviewDecision stays empty unless the repo requires reviews, so also read each
  // reviewer's latest verdict: approved when someone approved and nobody still asks for changes.
  const latest = new Map();
  for (const r of [...(j.reviews ?? [])].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state) && r.author?.login) latest.set(r.author.login, r.state);
  }
  const verdicts = [...latest.values()];
  const approved = j.reviewDecision === "APPROVED"
    || (j.reviewDecision !== "CHANGES_REQUESTED" && verdicts.includes("APPROVED") && !verdicts.includes("CHANGES_REQUESTED"));
  return {
    number: j.number,
    url: j.url,
    state: j.state,
    conflict: j.mergeable === "CONFLICTING",
    approved,
    ci: fail ? "fail" : run || j.ciComplete === false ? "run" : "pass",
    comments: comments.slice(0, 5),
    attentionIds,
    commentCount: attentionIds.length,
  };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.role !== undefined) return; // a card copy: no polling, no sidebar
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.pr = {}; // where() -> readPR's answer, null: no PR, missing: not known yet
    this.prNum = {}; // where() -> { number, url, branch, open, at }: the cached PR
    this.act = {}; // where() -> the last complete comment snapshot and its updatedAt
    this.prSeen = new Set(); // where()s that answered once (their first PR look stays quiet)
    this.asking = new Set(); // where()s a gh call is out for
    this.polled = {}; // where() -> when its PR was last asked for
    this.retry = {}; // where() -> when to ask again after a failure
    this.tries = {}; // where() -> consecutive failures, for the backoff
    this.ghDead = {}; // machine -> gh is missing or not signed in there until this ms
    this.authTold = new Set(); // machines already told about it
    this.holdUntil = 0; // polling stops until then: the budget is spent
    this.mergedDone = new Set(JSON.parse(localStorage.getItem("pr.merged.done") ?? "[]"));
    this.rebasing = {}; // space id -> a fetch/rebase in flight
    this.login = null; // gh account, so own comments don't notify
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["api", "user", "--jq", ".login"]);
        if (r.code === 0) this.login = r.stdout.trim();
      } catch {}
      cx.notify();
    });
    this.pollPRs(cx);
    cx.timer.every(120000, (cx) => this.pollPRs(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // keys.json: "cmd-shift-r": "github-spaces.refresh"
    cx.spawn(async (cx) => {
      for (;;) if ((await nextCommand()) === "refresh") this.refresh(cx);
    });
  }

  // Look at every space again now: git state, then its PR (a space polled in the last 30s is skipped, so mashing the key is cheap).
  refresh(cx) {
    this.refreshGit(new Set(Object.keys(this.git)), cx);
    this.pollPRs(cx, (k) => Date.now() - (this.polled[k] ?? 0) > 30000);
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      this.pollPRs(cx, (k) => !(k in this.pr)); // branches just became known: fetch missing PRs now, not at the next timer tick
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      // One call, two answers, in the order the flags were given.
      const paths = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd, on });
      if (paths.code !== 0) throw new Error(paths.stderr || "git rev-parse failed");
      const [top, repo] = paths.stdout.trim().split("\n");
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      if (info.branch !== this.git[key]?.branch) this.moved(key); // another branch, another PR
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  // Another branch: what was known about the old one is not about this one.
  moved(key) {
    delete this.pr[key];
    delete this.prNum[key];
    delete this.act[key];
    delete this.polled[key];
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => { const k = where(w, ps); return { w, i, k, g: this.git[k] ?? null }; }).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = tree || same(raw) || raw === "master" || raw === "main" ? "" : raw; // a worktree row never repeats its branch
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, k, g, tree }, t) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), (el) => el.pl(22).child(this.prMark(this.pr[k], g, t, w.id) ?? svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .when(!tree && this.pr[k]?.state === "OPEN", (el) => el.child(this.prMark(this.pr[k], g, t, w.id))) // plain spaces: open PRs only; old merged ones are noise
          .when(Boolean(g), (el) => el.child(this.fetchButton(w, g, t)))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  // Poll in background too. A known PR number is refreshed with one query per
  // repo; gh's own branch lookup (30 candidates, full commit history) is the
  // expensive part, so it runs on a miss. Comments are fetched only when the PR
  // reports a change.
  pollPRs(cx, only) {
    if (!window()) return; // check() has no window; the real app always polls
    const now = Date.now();
    if (now < this.holdUntil) return; // the shared budget is spent
    const ps = panes();
    const byKey = new Map();
    for (const s of spaces()) {
      const key = where(s, ps);
      let e = byKey.get(key);
      if (!e) byKey.set(key, e = { key, g: this.git[key], on: s.machine ?? null, list: [] });
      e.list.push(s);
    }
    const groups = new Map();
    for (const e of byKey.values()) {
      if (!e.g?.branch || this.asking.has(e.key) || (only && !only(e.key))) continue;
      if (now < (this.retry[e.key] ?? 0) || now < (this.ghDead[e.on] ?? 0)) continue;
      let group = groups.get(e.g.repo);
      if (!group) groups.set(e.g.repo, group = { on: e.on, jobs: [] });
      group.jobs.push(e);
    }
    for (const group of groups.values()) this.pollGroup(group, cx);
  }

  pollGroup(group, cx) {
    const now = Date.now();
    const known = [], rest = [];
    for (const j of group.jobs) {
      const c = this.prNum[j.key];
      // A merged PR is re-resolved now and then: a reused branch may have a new one.
      const hit = c && c.branch === j.g.branch && (c.open || now - c.at < 1800000);
      (hit ? known : rest).push(j);
    }
    for (let i = 0; i < known.length; i += BATCH) this.batch(known.slice(i, i + BATCH), group, cx);
    for (const j of rest) this.pollOne(j, cx);
  }

  // One GraphQL answer for several known PRs in the same repo.
  batch(jobs, group, cx) {
    const target = targetOf(this.prNum[jobs[0].key].url);
    if (!target) { for (const j of jobs) this.pollOne(j, cx); return; }
    for (const j of jobs) this.mark(j.key);
    const nums = [...new Set(jobs.map(j => this.prNum[j.key].number))];
    const aliases = nums.map(n => `p${n}: pullRequest(number:${n}) { ${STATUS} }`).join("\n");
    const query = `query($owner:String!, $name:String!) { rateLimit { remaining resetAt } repository(owner:$owner, name:$name) { ${aliases} } }`;
    const [owner, name] = target.repo.split("/");
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["api", "--hostname", target.host, "graphql", "-f", `query=${query}`,
          "-F", `owner=${owner}`, "-F", `name=${name}`], { on: group.on });
        if (r.code !== 0) throw new Error(r.stderr || "gh api failed");
        const body = JSON.parse(r.stdout);
        this.tally(body.data?.rateLimit);
        const bad = new Set((body.errors ?? []).map((e) => (e?.path ?? []).join(".")));
        // Publish the aliases that came back complete, in parallel; a failed
        // alias is re-resolved the old way instead of guessed at.
        await Promise.all(jobs.map(async (j) => {
          try {
            const c = this.prNum[j.key];
            const node = body.data?.repository?.[`p${c.number}`];
            if (!node || node.headRefName !== j.g.branch || bad.has(`repository.p${c.number}`) || bad.has("repository")) {
              delete this.prNum[j.key];
              if (Date.now() >= this.holdUntil) await this.lookup(j);
              return;
            }
            await this.deliver(j, fromBatch(node), { on: group.on, cwd: JSON.parse(j.key)[1] });
          } catch (e) { this.fail([j], e); }
        }));
      } catch (e) {
        this.fail(jobs, e);
        // A broken batch costs one cycle, not every mark in the repo.
        if (Date.now() < this.holdUntil) return;
        for (const j of jobs) { delete this.prNum[j.key]; await this.lookup(j); }
      } finally {
        for (const j of jobs) this.asking.delete(j.key);
        cx.notify();
      }
    });
  }

  // One place's PR, the long way: gh resolves the branch itself.
  pollOne(job, cx) {
    this.mark(job.key);
    cx.spawn(async (cx) => {
      try { await this.lookup(job); }
      finally { this.asking.delete(job.key); cx.notify(); }
    });
  }

  async lookup(job) {
    const { key, g, on } = job;
    try {
      const options = { cwd: JSON.parse(key)[1], on };
      const r = await exec("gh", ["pr", "view", g.branch, "--json", "number,url,state,mergeable,statusCheckRollup,author,commits,reviewDecision,updatedAt"], options);
      if (r.code === 0) await this.deliver({ ...job, fresh: true }, JSON.parse(r.stdout), options);
      else if (/no pull requests found|not a github repository|no git remotes found/i.test(r.stderr ?? "")) this.miss(job);
      else this.fail([job], new Error(r.stderr || r.stdout || "gh pr view failed"));
    } catch (e) {
      // gh wouldn't start there. A missing folder is that place's problem; a
      // missing gh, or a machine away, is the machine's. Ask once without it.
      this.fail([job], e);
      try { await exec("gh", ["--version"], { on }); } catch { this.dead(on); }
    }
  }

  mark(key) {
    this.asking.add(key);
    this.polled[key] = Date.now();
  }

  // The answer belongs to the branch that was asked about. If the checkout moved
  // while gh was thinking, nothing about this answer is true any more.
  async deliver(job, data, options) {
    const { key, g, list } = job;
    if (!targetOf(data.url)) throw new Error("Unrecognized PR URL");
    const now = this.git[key];
    if (!now || now.branch !== g.branch || now.repo !== g.repo) { delete this.polled[key]; return; }
    const saved = list[0] && (shared("github-spaces.comments") ?? {})[list[0].id];
    const pr = await this.build(key, g, data, options, saved);
    this.pr[key] = pr;
    const prev = this.prNum[key];
    this.prNum[key] = { number: pr.number, url: pr.url, branch: g.branch, open: pr.state === "OPEN",
      at: pr.state === "OPEN" || job.fresh || !prev ? Date.now() : prev.at };
    this.ok(key);
    for (const s of list) this.speak(s, key, g);
  }

  // Mark plus comment history. Activity is fetched only when the PR says it
  // changed; thread state is re-read whenever a comment still needs attention,
  // because resolving a thread does not move `updatedAt`.
  async build(key, g, data, options, saved) {
    const act = this.act[key];
    const same = act?.complete && act.number === data.number;
    const gate = same && Boolean(act.updatedAt) && act.updatedAt === data.updatedAt;
    let activity = gate ? act.data : null;
    if (!gate) {
      const got = await this.activity(data, options);
      if (got.complete) {
        activity = got.data;
        this.act[key] = { number: data.number, updatedAt: data.updatedAt, complete: true, data: got.data, threads: same ? act.threads : null };
      } else if (same) activity = act.data; // same PR: keep what it showed
    }
    const old = this.pr[key];
    // Threads only matter for inline comments, and on an unchanged PR only
    // while one of them is still showing as needing attention.
    const inline = (activity?.reviewComments?.length ?? 0) > 0;
    const asked = inline && (!gate || (old?.attentionIds?.length ?? 0) > 0);
    const threads = asked ? await this.threads(data, options) : null;
    if (threads && this.act[key]) this.act[key].threads = threads;
    if (!activity) {
      // A restart with a failing endpoint: publish the mark, keep the saved
      // cards and their count instead of inventing an empty history.
      const pr = readPR(data, this.login);
      pr.comments = []; pr.attentionIds = []; pr.commentCount = 0; pr.incomplete = true;
      if (saved?.pr === `${g.repo}#${pr.number}`) {
        pr.comments = saved.comments ?? [];
        pr.attentionIds = saved.attentionIds ?? [];
        pr.commentCount = pr.attentionIds.length;
      }
      return pr;
    }
    return readPR({ ...data, ...activity, reviewThreads: threads ?? (same ? act.threads : undefined) }, this.login);
  }

  // Three lists, paginated. A partial answer is worse than none: the caller keeps
  // the previous snapshot rather than reading missing comments as resolved.
  async activity(data, options) {
    const target = targetOf(data.url);
    if (!target) return { complete: false };
    const out = {};
    let complete = true;
    for (const [field, endpoint] of [
      ["comments", `issues/${data.number}/comments`],
      ["reviews", `pulls/${data.number}/reviews`],
      ["reviewComments", `pulls/${data.number}/comments`],
    ]) {
      try {
        const r = await exec("gh", ["api", "--hostname", target.host,
          `repos/${target.repo}/${endpoint}?per_page=100`, "--paginate", "--slurp"], options);
        if (r.code !== 0) { complete = false; console.warn(r.stderr); continue; }
        const pages = JSON.parse(r.stdout);
        if (!Array.isArray(pages) || !pages.every(Array.isArray)) { complete = false; continue; }
        const rows = pages.flat();
        out[field] = field === "reviewComments" ? rows : rows.map(c => ({
          ...c, author: c.user, url: c.html_url, createdAt: c.created_at, submittedAt: c.submitted_at,
        }));
      } catch (e) { complete = false; console.warn(e?.message ?? e); }
    }
    return { complete, data: out };
  }

  async threads(data, options) {
    const target = targetOf(data.url);
    if (!target) return null;
    const [owner, name] = target.repo.split("/");
    try {
      const r = await exec("gh", ["api", "--hostname", target.host, "graphql", "-f", `query=${REVIEW_THREADS}`,
        "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${data.number}`, "--paginate", "--slurp"], options);
      if (r.code !== 0) return null;
      const pages = JSON.parse(r.stdout);
      this.tally(pages[0]?.data?.rateLimit);
      const last = pages.at(-1)?.data?.repository?.pullRequest?.reviewThreads;
      if (!pages.length || !pages.every(p => !p.errors && Array.isArray(p.data?.repository?.pullRequest?.reviewThreads?.nodes))
        || last?.pageInfo?.hasNextPage !== false) return null;
      return pages.flatMap(p => p.data.repository.pullRequest.reviewThreads.nodes);
    } catch { return null; }
  }

  // gh answered: this branch has no PR. Absence clears the mark and the dock;
  // every other failure keeps both.
  miss(job) {
    delete this.prNum[job.key];
    delete this.act[job.key];
    this.pr[job.key] = null;
    this.ok(job.key);
    for (const s of job.list) this.forget(s);
  }

  forget(s) {
    const cards = shared("github-spaces.comments") ?? {};
    if (!(s.id in cards)) return;
    const next = { ...cards };
    delete next[s.id];
    setShared("github-spaces.comments", next);
  }

  ok(key) {
    delete this.retry[key];
    delete this.tries[key];
  }

  // Short waits for one place; the machine is only paused when gh itself is
  // missing or not signed in, and the shared budget only when it is spent.
  fail(jobs, e) {
    const text = String(e?.message ?? e);
    if (/rate limit|secondary rate|abuse/i.test(text)) {
      this.holdUntil = Math.max(this.holdUntil, Date.now() + 300000);
      return;
    }
    if (/authentication|not logged in|gh auth login|bad credentials|HTTP 401/i.test(text)) {
      for (const j of jobs) this.dead(j.on);
      return;
    }
    const now = Date.now();
    for (const j of jobs) {
      const n = (this.tries[j.key] = (this.tries[j.key] ?? 0) + 1);
      this.retry[j.key] = now + Math.min(2000 * 2 ** (n - 1), 1800000);
    }
  }

  dead(on) {
    this.ghDead[on] = Date.now() + 1800000;
    if (this.authTold.has(on)) return;
    this.authTold.add(on);
    notify({
      title: "GitHub status paused",
      body: `${on ?? "This computer"}: gh is missing or not signed in. PR marks resume in 30 minutes.`,
      level: "warning",
      timeout: 10000,
    });
  }

  // An answer reports the shared budget; stop before it runs out, not after.
  tally(limit) {
    if (!limit) return;
    const at = Date.parse(limit.resetAt ?? "");
    if (limit.remaining < 120) this.holdUntil = Math.max(this.holdUntil, at > Date.now() ? at + 60000 : Date.now() + 300000);
  }

  // Dock history survives resolution and commits; only new activity reopens a dismissed card.
  speak(s, key, g) {
    const pr = this.pr[key];
    const first = !this.prSeen.has(key);
    this.prSeen.add(key);
    if (!pr || pr.incomplete) return; // a failed activity read is not an empty one
    const id = `${g.repo}#${pr.number}`;
    const cards = shared("github-spaces.comments") ?? {};
    const old = cards[s.id];
    const revision = pr.comments.map(c => c.id).join("\n");
    // Attention ids refresh every poll (resolution changes them without a
    // new comment list); per-comment dismissal is carried over. A legacy
    // whole-dock "dismissed" closes everything that list knew.
    if (!old || old.pr !== id || old.revision !== revision
      || JSON.stringify(old.attentionIds ?? []) !== JSON.stringify(pr.attentionIds ?? [])) {
      // Toast for pending comments missing from the saved list; no saved list (first install) means no toast.
      const known = new Set((old?.comments ?? []).map(c => c.id));
      const fresh = old?.pr === id
        ? pr.comments.filter(c => !known.has(c.id) && (pr.attentionIds ?? []).includes(c.id)) : [];
      if (fresh.length) notify({
        title: `PR #${pr.number}: ${fresh[0].author} commented`,
        body: fresh.length > 1 ? `${fresh.length} new comments in ${s.name}` : `${s.name}: ${fresh[0].body.split("\n")[0].slice(0, 120)}`,
        level: "info",
        timeout: 15000,
        action: { name: "space.select", args: { id: s.id } },
      });
      const legacy = Array.isArray(old?.dismissedIds) ? old.dismissedIds
        : old?.dismissed ? (old.comments ?? []).map(c => c.id) : [];
      setShared("github-spaces.comments", { ...cards, [s.id]: {
        pr: id, at: pr.comments[0]?.at ?? "", revision, title: `PR #${pr.number} · ${s.name}`,
        comments: pr.comments, attentionIds: pr.attentionIds ?? [],
        dismissedIds: [...new Set(legacy.filter(i => pr.comments.some(c => c.id === i)))],
      } });
    }
    if (pr.state === "MERGED" && !this.mergedDone.has(id)) {
      this.mergedDone.add(id);
      localStorage.setItem("pr.merged.done", JSON.stringify([...this.mergedDone]));
      if (!first) {
        notify({
          title: `PR #${pr.number} merged`,
          body: `${s.name}: the branch is in. Delete its worktree?`,
          level: "success",
          action: { name: "space.select", args: { id: s.id } },
        });
        if (g.linked) openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: s.id, action: "remove" } });
      }
    }
  }

  // The PR mark: ✗ failed, spinner running, ✓ passing, ● merged (purple), ○
  // closed. The bubble counts pending human comments: resolution and closing
  // a card, or a newer commit, drop them. Marks use explicit colors,
  // not theme ansi: graphite's ansi1 is pink, and the marks must read at a glance.
  prMark(pr, g, t, sid) {
    if (!pr) return null;
    const status = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.conflict ? "conflict" : pr.ci;
    const look = {
      conflict: ["conflict", "#f97316", "merge conflicts with base branch"],
      fail: ["x", "#ef4444", "checks failed"],
      run: ["spinner", "#eab308", "checks running"],
      pass: ["circle-check", "#22c55e", "checks passing"],
      merged: ["circle-check", "#a78bfa", "merged"],
      closed: ["minus", t.dim, "closed"],
    }[status];
    const card = sid ? (shared("github-spaces.comments") ?? {})[sid] : null;
    const closed = new Set(card ? (card.dismissedIds ?? (card.dismissed ? (card.comments ?? []).map(c => c.id) : [])) : []);
    const count = (pr.attentionIds ?? []).filter(i => !closed.has(i)).length;
    return h_flex().id(`pr-${pr.number}`).gap(4).items_center().flex_none()
      .tooltip(`PR #${pr.number} · ${look[2]}`)
      .child(svg(status === "conflict" ? "mods/github-spaces/conflict.svg" : `mods/workspace-chrome/${look[0]}.svg`)
        .size(status === "run" ? 12 : 13).flex_none().text_color(look[1])
        .when(status === "run", el => el.spin(900)))
      .when(pr.approved && pr.state === "OPEN", el => el.child(h_flex().id(`pr-approved-${pr.number}`).flex_none().items_center()
        .tooltip(`PR #${pr.number} · approved`)
        .child(svg("mods/github-spaces/approved.svg").size(13).flex_none().text_color("#38bdf8"))))
      .child(div().id(`pr-open-${pr.number}`).text_size(10.5).text_color(t.dim).cursor_pointer()
        .hover(s => s.text_color(t.accent)).tooltip("Open PR on GitHub")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); if (pr.url) cx.open_url(pr.url); })
        .child(`#${pr.number}`))
      .when(count > 0, el => el.child(h_flex().gap(2).items_center().flex_none().text_color(t.accent)
        .tooltip(`${count} human comments need attention`)
        .child(svg("mods/github-spaces/comment.svg").size(12).flex_none())
        .child(div().text_size(10).font_bold().child(String(count)))));
  }

  // Only strictly behind is red; divergence may be a rebase or new remote
  // commits, so counts alone cannot recommend rebasing or pushing.
  fetchButton(w, g, t) {
    const behind = g?.behind ?? 0;
    const needs = behind > 0 && (g?.ahead ?? 0) === 0;
    const tip = needs ? `git fetch + rebase · ${behind} behind`
      : behind > 0 ? `diverged · ↑${g.ahead} ↓${behind} — inspect history before rebase or push`
      : "git fetch + rebase";
    if (this.rebasing[w.id]) return svg("mods/github-spaces/arrow-down.svg").size(14).flex_none().spin(900).text_color(t.accent);
    return h_flex().id(`frb-${w.id}`).flex_none().items_center().rounded(4).cursor_pointer().gap(2)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.fetchRebase(w, cx); })
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .child(svg("mods/github-spaces/arrow-down.svg").size(14).flex_none().text_color(needs ? "#ef4444" : t.ansi4))
      .when(needs, (el) => el.child(div().id(`frb-n-${w.id}`).flex().flex_none().items_center().justify_center().h(16).min_w(16).px(5).rounded(8).bg("#ef4444").text_size(10.5).font_bold().text_color("#ffffff").child(String(behind))));
  }

  // `git rebase` follows the branch's own upstream; a refusal (dirty tree,
  // conflicts, no upstream) shows git's words, and nothing is thrown away.
  fetchRebase(w, cx) {
    if (this.rebasing[w.id]) return;
    const at = place(w, panes());
    const on = w.machine ?? null;
    const key = JSON.stringify([on, at]);
    if (!this.git[key]) return;
    this.rebasing[w.id] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let err = "";
      try {
        const f = await exec("git", ["fetch"], { cwd: at, on });
        if (f.code !== 0) err = f.stderr || "git fetch failed.";
        else {
          const r = await exec("git", ["rebase"], { cwd: at, on });
          if (r.code !== 0) err = r.stderr || r.stdout || "git rebase failed.";
        }
      } catch (e) { err = String(e?.message ?? e); }
      delete this.rebasing[w.id];
      // What fetch brought in moves every checkout of the repo.
      this.refreshGit(this.sameRepo(key, Object.keys(this.git)), cx);
      if (err) notify({ title: `Fetch/rebase · ${w.name}`, body: err.trim().split("\n").slice(0, 2).join(" "), level: "error", timeout: 8000 });
      cx.notify();
    });
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    if (props()?.role !== undefined) return commentCard(props().slot);
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child(div()
          .when(this.holdUntil > Date.now(), x => x.tooltip(`GitHub rate limit · polling resumes ${new Date(this.holdUntil).toISOString().slice(11, 16)} UTC`))
          .child("Spaces")))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
