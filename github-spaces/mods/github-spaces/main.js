// GitHub on which checkout: the info layer behind the Spaces sidebar. The
// sidebar mod (spaces-stacks) publishes the checkouts it knows to shared
// "spaces.git"; this mod answers with the PR each one is on and publishes
// "github-spaces.prs" for the sidebar to draw. Nothing here draws the sidebar.
// It also keeps the comment cards (dock.js), their counts, and the merge and
// comment notifications.
//
// There is no global refresh: the sidebar's per-repo control posts
// shared "github-spaces.want" and this mod re-resolves that one repo.

import { View, div } from "gpui-kit";
import { commentCard } from "./dock.js";
import { openOverlay, exec, shared, setShared, window, notify, props } from "herdr";

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
const STATUS = `number url state mergeable reviewDecision updatedAt headRefName baseRefName
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
    baseRefName: node.baseRefName,
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
    base: j.baseRefName ?? null,
    conflict: j.mergeable === "CONFLICTING",
    approved,
    ci: fail ? "fail" : run || j.ciComplete === false ? "run" : "pass",
    comments: comments.slice(0, 5),
    commentsTotal: comments.length,
    attentionIds,
    commentCount: attentionIds.length,
  };
}

export default class GitHubInfo extends View {
  init(_props, cx) {
    if (props()?.role !== undefined) return; // a card copy: no polling
    this.git = {}; // where() -> the checkout the sidebar published
    this.asked = null; // the published checkouts as they were when last read
    this.pr = {}; // where() -> readPR's answer, null: no PR, missing: not known yet
    this.prNum = {}; // where() -> { number, url, branch, open, at }: the cached PR
    this.act = {}; // where() -> the last complete comment snapshot and its updatedAt
    this.prSeen = new Set(); // where()s that answered once (their first PR look stays quiet)
    this.asking = new Set(); // where()s a gh call is out for
    this.askingAt = {}; // when each of those started, so a dropped task cannot wedge a key
    this.polled = {}; // where() -> when its PR was last asked for
    this.retry = {}; // where() -> when to ask again after a failure
    this.tries = {}; // where() -> consecutive failures, for the backoff
    this.ghDead = {}; // machine -> gh is missing or not signed in there until this ms
    this.authTold = new Set(); // machines already told about it
    this.holdUntil = Number(shared("github-spaces.hold")) || 0; // a hold survives a reload
    this.holdTold = this.holdUntil; // the hold as last published, so an unchanged one writes nothing
    // PR numbers by repo|branch: a reload batches by number instead of asking
    // gh to resolve every branch again (the expensive path, and the budget).
    try { this.saved = JSON.parse(localStorage.getItem("pr.numbers") ?? "{}") ?? {}; } catch { this.saved = {}; }
    this.mergedDone = new Set(JSON.parse(localStorage.getItem("pr.merged.done") ?? "[]"));
    this.login = null; // gh account, so own comments don't notify
    this.published = null; // the PR map as last written, so an unchanged poll writes nothing
    this.wroteAt = 0; // last shared write: answers arrive in bursts, renders cost more than the write
    this.wantAt = 0; // the last on-demand repo refresh the sidebar asked for
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["api", "user", "--jq", ".login"]);
        if (r.code === 0) this.login = r.stdout.trim();
      } catch {}
      cx.notify();
    });
    this.sync(cx);
    // The sidebar publishes its checkouts as it looks at them; read them often
    // enough that a branch change is answered in seconds, not minutes.
    cx.timer.every(15000, (cx) => this.sync(cx));
    cx.timer.every(120000, (cx) => this.pollPRs(cx));
    cx.timer.every(1000, () => this.publish()); // answers suppressed by the write gap land here
    // The sidebar's refresh control per repo: shared "github-spaces.want".
    cx.timer.every(1000, (cx) => this.checkWant(cx));
  }

  // The sidebar's checkouts, as of its last look. A changed set (new space, a cd,
  // a checkout) means new PRs to resolve; a place that went away drops its state.
  sync(cx) {
    const map = shared("spaces.git") ?? {};
    const json = JSON.stringify(map);
    if (json === this.asked) return;
    this.asked = json;
    const next = {};
    for (const [key, entry] of Object.entries(map)) if (entry?.branch) next[key] = entry;
    // A key is a checkout, not a branch: when the branch moved under it (the
    // sidebar's picker does exactly that), the old answer is not about this one.
    for (const [key, entry] of Object.entries(next)) {
      const was = this.git[key];
      if (was && (was.branch !== entry.branch || was.repo !== entry.repo)) this.moved(key);
    }
    for (const key of Object.keys(this.git)) {
      if (next[key]) continue;
      delete this.pr[key]; delete this.prNum[key]; delete this.act[key];
      delete this.polled[key]; delete this.retry[key]; delete this.tries[key];
      this.markDone(key);
    }
    this.git = next;
    for (const [key, g] of Object.entries(next)) {
      const known = this.saved?.[`${g.repo}|${g.branch}`];
      if (known && !this.prNum[key]) this.prNum[key] = known;
    }
    this.publish();
    this.pollPRs(cx, () => true);
  }

  // Another branch on the same checkout: what was known about the old one is
  // not about this one, and its first answer stays quiet.
  moved(key) {
    delete this.pr[key];
    delete this.prNum[key];
    delete this.act[key];
    delete this.polled[key];
    delete this.retry[key];
    delete this.tries[key];
    this.markDone(key); // do not leave the old branch's call marked in flight
    this.prSeen.delete(key);
  }

  // One repo, on demand: every branch there is asked again now. Known PRs go
  // through the number batch, the rest through one head-ref batch, so a refresh
  // costs about two GraphQL queries per repo, not one per branch.
  refreshRepo(repo, cx) {
    if (Date.now() < this.holdUntil) {
      notify({ title: "GitHub paused", body: `Rate limit: PR marks resume ${new Date(this.holdUntil).toISOString().slice(11, 16)} UTC.`, level: "warning", timeout: 8000 });
      return;
    }
    for (const [key, g] of Object.entries(this.git)) {
      if (g.repo !== repo) continue;
      delete this.polled[key]; delete this.retry[key]; delete this.tries[key];
    }
    this.pollPRs(cx, (k) => this.git[k]?.repo === repo);
  }

  checkWant(cx) {
    const want = shared("github-spaces.want");
    if (!want?.at || want.at <= this.wantAt) return;
    this.wantAt = want.at;
    this.refreshRepo(want.repo, cx);
  }

  // Poll in background too. A known PR number is refreshed with one query per
  // repo; gh's own branch lookup (30 candidates, full commit history) is the
  // expensive part, so it runs on a miss. Comments are fetched only when the PR
  // reports a change.
  pollPRs(cx, only) {
    if (!window()) return; // check() has no window; the real app always polls
    const now = Date.now();
    if (now < this.holdUntil) return; // the shared budget is spent
    const groups = new Map();
    for (const [key, g] of Object.entries(this.git)) {
      if (!g.branch || this.inFlight(key, now) || (only && !only(key))) continue;
      if (now < (this.retry[key] ?? 0) || now < (this.ghDead[g.on ?? null] ?? 0)) continue;
      let group = groups.get(g.repo);
      if (!group) groups.set(g.repo, group = { on: g.on ?? null, jobs: [] });
      group.jobs.push({ key, g, list: g.spaces ?? [g] });
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
    // Branches with no cached number are resolved by head ref, one query per
    // repo chunk, instead of `gh pr view` per branch (30 candidates each).
    for (let i = 0; i < rest.length; i += BATCH) this.batchBranches(rest.slice(i, i + BATCH), group, cx);
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
              if (this.canAsk(j)) await this.lookup(j);
              return;
            }
            await this.deliver(j, fromBatch(node), { on: group.on, cwd: JSON.parse(j.key)[1] });
          } catch (e) { this.fail([j], e); }
        }));
      } catch (e) {
        this.fail(jobs, e);
        // A broken batch costs one cycle, not every mark in the repo.
        if (Date.now() < this.holdUntil) return;
        for (const j of jobs) { delete this.prNum[j.key]; if (this.canAsk(j)) await this.lookup(j); }
      } finally {
        for (const j of jobs) this.markDone(j.key);
        cx.notify();
      }
    });
  }

  // Several branches with no cached PR number, discovered in one REST call:
  // GET /repos/{owner}/{repo}/pulls?state=all lists every PR and its head ref.
  // REST GETs cost one point of a 5,000/hour budget, where `gh pr view` per
  // branch asked for 30 candidates plus commit history each.
  batchBranches(jobs, group, cx) {
    const slug = jobs.map(j => j.g.slug ?? this.git[j.key]?.slug).find(Boolean);
    const [owner, name] = String(slug ?? "").split("/");
    if (!owner || !name) { for (const j of jobs) this.pollOne(j, cx); return; } // no remote known: the long way
    for (const j of jobs) this.mark(j.key);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["api", "--hostname", "github.com",
          `repos/${owner}/${name}/pulls?state=all&per_page=100&sort=updated&direction=desc`, "--slurp"], { on: group.on });
        if (r.code !== 0) throw new Error(r.stderr || "gh api failed");
        const pages = JSON.parse(r.stdout);
        const prs = (Array.isArray(pages) ? pages : [pages]).flat();
        const full = prs.length >= 100; // more PRs than one page: absence proves nothing
        const found = [];
        for (const j of jobs) {
          const mine = prs.filter(p => p.head?.ref === j.g.branch);
          const pr = mine.find(p => p.state === "open")
            ?? mine.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
          if (!pr) {
            if (full) { if (this.canAsk(j)) await this.lookup(j); } else this.miss(j);
            continue;
          }
          // Only the number is known here; checks, mergeability and approvals
          // come from the number batch, which is one point per ten PRs.
          this.prNum[j.key] = { number: pr.number, url: pr.html_url, branch: j.g.branch, open: pr.state === "open", at: Date.now() };
          this.remember(j.g, this.prNum[j.key]);
          found.push(j);
        }
        if (found.length) this.batch(found, group, cx);
      } catch (e) {
        this.fail(jobs, e);
        if (Date.now() < this.holdUntil) return;
        for (const j of jobs) if (this.canAsk(j)) await this.lookup(j);
      } finally {
        for (const j of jobs) this.markDone(j.key);
        cx.notify();
      }
    });
  }

  // One place's PR, the long way: gh resolves the branch itself. A burst of gh
  // processes reads as abuse and trips GitHub's secondary limit, so these run a
  // few at a time.
  pollOne(job, cx) {
    this.mark(job.key);
    (this.queue ??= []).push(job);
    this.drain(cx);
  }

  drain(cx) {
    const queue = this.queue ??= [];
    while ((this.running ?? 0) < 4 && queue.length) {
      const job = queue.shift();
      this.running = (this.running ?? 0) + 1;
      cx.spawn(async (cx) => {
        try { await this.lookup(job); }
        finally {
          this.running--;
          this.markDone(job.key);
          this.drain(cx);
          cx.notify();
        }
      });
    }
  }

  async lookup(job) {
    const { key, g } = job;
    try {
      const options = { cwd: JSON.parse(key)[1], on: g.on ?? null };
      const r = await exec("gh", ["pr", "view", g.branch, "--json", "number,url,state,mergeable,statusCheckRollup,author,commits,reviewDecision,updatedAt,baseRefName"], options);
      if (r.code === 0) await this.deliver({ ...job, fresh: true }, JSON.parse(r.stdout), options);
      else if (/no pull requests found|not a github repository|no git remotes found/i.test(r.stderr ?? "")) this.miss(job);
      else this.fail([job], new Error(r.stderr || r.stdout || "gh pr view failed"));
    } catch (e) {
      // gh wouldn't start there. A missing folder is that place's problem; a
      // missing gh, or a machine away, is the machine's. Ask once without it.
      this.fail([job], e);
      try { await exec("gh", ["--version"], { on: g.on ?? null }); } catch { this.dead(g.on ?? null); }
    }
  }

  mark(key) {
    this.asking.add(key);
    (this.askingAt ??= {})[key] = Date.now();
    this.polled[key] = Date.now();
  }

  markDone(key) {
    this.asking.delete(key);
    if (this.askingAt) delete this.askingAt[key];
  }

  // A gh call that never finished (a dropped task, a reload) must not stop this
  // key for good. Past a minute, ask again.
  inFlight(key, now) {
    return this.asking.has(key) && now - ((this.askingAt ?? {})[key] ?? 0) < 60000;
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
    this.remember(g, this.prNum[key]);
    this.publish();
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
    this.remember(job.g, null);
    this.publish();
    for (const s of job.list) this.forget(s);
  }

  // A machine that is out of budget, missing gh, or backing off is not asked again.
  canAsk(j) {
    const now = Date.now();
    return now >= this.holdUntil && now >= (this.ghDead[j.g.on ?? null] ?? 0) && now >= (this.retry[j.key] ?? 0);
  }

  // The PR number outlives a reload: a batch by number is one query where
  // `gh pr view <branch>` is one per branch, each asking for 30 candidates.
  remember(g, pr) {
    const saved = this.saved ??= {};
    const k = `${g.repo}|${g.branch}`;
    if (pr) saved[k] = pr; else delete saved[k];
    // Closed branches are not worth keeping forever; 30 days is plenty.
    if (Object.keys(saved).length > 400) {
      for (const [key, v] of Object.entries(saved)) {
        if (!v?.open && Date.now() - (v?.at ?? 0) > 30 * 86400000) delete saved[key];
      }
    }
    localStorage.setItem("pr.numbers", JSON.stringify(saved));
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
      this.publishHold();
      return;
    }
    if (/authentication|not logged in|gh auth login|bad credentials|HTTP 401/i.test(text)) {
      for (const j of jobs) this.dead(j.g.on ?? null);
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
    if (limit.remaining < 120) {
      this.holdUntil = Math.max(this.holdUntil, at > Date.now() ? at + 60000 : Date.now() + 300000);
      this.publishHold();
    }
  }

  // The sidebar says when polling resumes; write it only when it moves.
  publishHold() {
    if (this.holdUntil === this.holdTold) return;
    this.holdTold = this.holdUntil;
    setShared("github-spaces.hold", this.holdUntil);
  }

  // What the sidebar draws: one entry per checkout, keyed the way it keys its
  // own git state. Unanswered checkouts keep the last answer, so a reload never
  // blanks the marks; a confirmed no-PR drops its entry. Written only when it
  // changed, since a write re-renders every mod, this one included.
  publish() {
    if (!Object.keys(this.git).length) return; // nothing known yet: keep what is published
    const prev = this.lastPrs ??= (shared("github-spaces.prs") ?? {});
    const map = {};
    for (const [key, g] of Object.entries(this.git)) {
      const k = `${g.repo}|${g.branch}`;
      const pr = this.pr[key];
      if (pr === undefined) { if (!(k in map) && prev[k]) map[k] = prev[k]; continue; } // not asked yet
      if (!pr) continue; // confirmed: this branch has no PR
      map[k] = {
        number: pr.number, url: pr.url, state: pr.state, base: pr.base,
        conflict: pr.conflict, ci: pr.ci, approved: pr.approved,
        attentionIds: pr.attentionIds, commentsTotal: pr.commentsTotal ?? 0,
      };
    }
    this.lastPrs = map;
    const sorted = {};
    for (const k of Object.keys(map).sort()) sorted[k] = map[k];
    const json = JSON.stringify(sorted);
    if (json === this.published) return;
    // Every write re-renders every mounted mod; a burst of answers must not
    // become a burst of renders. The 1s timer publishes what this skips.
    const now = Date.now();
    if (now - this.wroteAt < 750) return;
    this.wroteAt = now;
    this.published = json;
    setShared("github-spaces.prs", sorted);
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

  // The 1px block the layout mounts this in draws nothing; the comment cards
  // are extra copies with a role.
  render() {
    if (props()?.role !== undefined) return commentCard(props().slot);
    return div();
  }
}
