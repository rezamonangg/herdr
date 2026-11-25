const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Record native builder output without needing a running Herdr window.
function element(kind) {
  const node = { kind, items: [] };
  let proxy;
  proxy = new Proxy(node, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === 'when') { if (args[0]) args[1](proxy); }
        else if (key === 'child') {
          assert.ok(args[0] != null, 'native child cannot be null');
          target.items.push(args[0]);
        } else if (key === 'children') {
          target.items.push(...args[0]);
        } else target[key] = args[0];
        return proxy;
      };
    },
  });
  return proxy;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-spaces-test-'));
  const cwd = path.join(dir, 'checkout');
  fs.mkdirSync(cwd);
  let githubResponse;
  const exec = (cmd, args, options = {}) => {
    if (cmd === 'gh') return githubResponse(args, options);
    const r = spawnSync(cmd, args, { cwd: options.cwd || cwd, encoding: 'utf8', timeout: 10000 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  try {
    const cardsWritten = [];
    const toasts = [];
    const storage = new Map();
    const polledSpaces = [];
    const source = fs.readFileSync(path.join(__dirname, 'mods/github-spaces/main.js'), 'utf8')
      .replace(/^import .*;$/gm, '').replace(/export default class /, 'class ').replace(/^export /gm, '');
    const { GitHubInfo, readPR } = vm.runInNewContext(`${source}\n({ GitHubInfo, readPR })`, {
      console,
      View: class {}, div: () => element('div'), h_flex: () => element('row'),
      svg: (p) => element(p), exec,
      notify: n => toasts.push(n),
      shared: k => storage.get(k),
      setShared: (k, v) => { storage.set(k, v); cardsWritten.push(v); },
      localStorage: { setItem: (k, v) => storage.set(k, v) },
      spaces: () => polledSpaces, panes: () => [], window: () => ({ active: false }),
    }, { timeout: 1000 });
    const view = new GitHubInfo();
    view.git = {};
    view.pr = {}; view.act = {}; view.prNum = {}; view.retry = {}; view.tries = {};
    view.ghDead = {}; view.authTold = new Set(); view.holdUntil = 0;
    // Conflict, state and CI precedence, as data: the mark is drawn by the
    // sidebar mod, which reads exactly these fields.
    for (const [name, state, mergeable, ci, conflict, expectedCi] of [
      ['conflict beats passing CI', 'OPEN', 'CONFLICTING', 'SUCCESS', true, 'pass'],
      ['conflict beats running CI', 'OPEN', 'CONFLICTING', 'QUEUED', true, 'run'],
      ['conflict beats failed CI', 'OPEN', 'CONFLICTING', 'FAILURE', true, 'fail'],
      ['merged beats conflict', 'MERGED', 'CONFLICTING', 'SUCCESS', true, 'pass'],
      ['closed beats conflict', 'CLOSED', 'CONFLICTING', 'SUCCESS', true, 'pass'],
      ['unknown is not conflict', 'OPEN', 'UNKNOWN', 'SUCCESS', false, 'pass'],
      ['resolved conflict restores CI', 'OPEN', 'MERGEABLE', 'FAILURE', false, 'fail'],
    ]) {
      const pr = readPR({ number: 1, state, mergeable, statusCheckRollup: [{ conclusion: ci }] });
      assert.equal(pr.conflict, conflict, name);
      assert.equal(pr.state, state, name);
      assert.equal(pr.ci, expectedCi, `${name}: CI`);
      console.log(`PASS ${name}`);
    }
    view.prSeen = new Set(); view.pr = {}; view.mergedDone = new Set();
    view.login = 'me';
    const comment = (id, at, login = 'reviewer', type = 'User') => ({
      id, author: { login, type }, createdAt: at, body: `Comment ${id}`,
      url: `https://github.com/test/repo/pull/1063#issuecomment-${id}`,
    });
    const fixture = { number: 1063, state: 'OPEN', author: { login: 'me' },
      comments: Array.from({ length: 7 }, (_, i) => comment(i + 1, `2026-11-03T07:0${i + 1}:00Z`)) };
    fixture.comments.reverse(); // API ordering must not control the latest-five list.
    fixture.comments.push(comment(8, '2026-11-03T08:00:00Z', 'me'));
    let pr = readPR(fixture, view.login);
    assert.ok(Array.isArray(pr.comments), 'dock exposes a comment list');
    assert.equal(pr.comments.length, 5, 'dock keeps only five comments');
    assert.deepEqual(Array.from(pr.comments, c => c.body), ['Comment 7', 'Comment 6', 'Comment 5', 'Comment 4', 'Comment 3']);
    assert.equal(pr.commentCount, 7, 'sidebar count includes human feedback beyond the five dock entries');
    const inline = { id: 42, user: { login: 'reviewer', type: 'User' },
      created_at: '2026-11-03T09:00:00Z', body: 'Please fix this line',
      html_url: 'https://github.com/test/repo/pull/1063#discussion_r42' };
    const feedback = { ...fixture, comments: [], reviewComments: [inline] };
    for (const [name, extra, expected] of [
      ['unresolved human thread', {}, true],
      ['resolved human thread', { reviewThreads: [{ isResolved: true, comments: { nodes: [{ databaseId: 42 }] } }] }, false],
      ['commit after the comment clears attention', { commits: [{ committedDate: '2026-11-03T10:00:00Z' }] }, false],
      ['commit before the comment keeps attention', { commits: [{ committedDate: '2026-11-03T08:00:00Z' }] }, true],
      ['bot-only feedback', { reviewComments: [{ ...inline, user: { login: 'review-bot', type: 'Bot' } }] }, false],
      ['bot in username', { reviewComments: [{ ...inline, user: { login: 'reviewBot', type: 'User' } }] }, false],
    ]) {
      pr = readPR({ ...feedback, ...extra }, view.login);
      assert.equal(pr.commentCount > 0, expected, `${name}: comment count`);
      assert.equal(pr.attentionIds.length > 0, expected, `${name}: published attention`);
      assert.equal(pr.comments.length, name.includes('bot') ? 0 : 1, `${name}: dock excludes bots but keeps resolved human history`);
      console.log(`PASS ${name}`);
    }
    assert.equal(readPR({ ...fixture, reviewDecision: 'APPROVED' }, 'me').approved, true, 'an approved PR is flagged');
    assert.equal(readPR({ ...fixture, reviewDecision: 'CHANGES_REQUESTED' }, 'me').approved, false);
    const verdict = (who, state, at) => ({ author: { login: who }, state, submittedAt: at, body: '' });
    assert.equal(readPR({ ...fixture, reviewDecision: '', reviews: [verdict('alfin', 'APPROVED', '2026-11-05T01:00:00Z')] }, 'me').approved, true, 'an approval counts even when reviewDecision is empty');
    assert.equal(readPR({ ...fixture, reviewDecision: '', reviews: [verdict('alfin', 'APPROVED', '2026-11-05T01:00:00Z'), verdict('dede', 'CHANGES_REQUESTED', '2026-11-05T02:00:00Z')] }, 'me').approved, false, 'another reviewer asking for changes blocks it');
    assert.equal(readPR({ ...fixture, reviewDecision: '', reviews: [verdict('alfin', 'CHANGES_REQUESTED', '2026-11-05T01:00:00Z'), verdict('alfin', 'APPROVED', '2026-11-05T02:00:00Z')] }, 'me').approved, true, 'a reviewer\'s latest verdict wins');
    assert.equal(readPR({ ...fixture, reviewDecision: '', reviews: [verdict('alfin', 'APPROVED', '2026-11-05T01:00:00Z'), verdict('alfin', 'DISMISSED', '2026-11-05T02:00:00Z')] }, 'me').approved, false, 'a dismissed approval no longer counts');
    const approvedPR = readPR({ ...fixture, reviewDecision: 'APPROVED' }, 'me');
    assert.equal(approvedPR.approved, true, 'an approved PR is flagged for the sidebar');
    assert.equal(readPR({ ...fixture }, 'me').approved, false, 'no approval, no flag');
    pr = readPR({ ...feedback, author: { login: 'reviewer' } }, 'me');
    assert.equal(pr.commentCount + pr.comments.length, 0, "the PR creator's own comments never count or show");
    const resolved = { reviewThreads: [{ isResolved: true, comments: { nodes: [{ databaseId: 42 }] } }] };
    pr = readPR({ ...feedback, ...resolved, reviewComments: [inline, { ...inline, id: 43, in_reply_to_id: 42 }] }, 'me');
    assert.equal(pr.commentCount, 0, 'thread resolution covers inline replies');
    pr = readPR({ ...feedback, ...resolved, reviewComments: [inline, {
      ...inline, id: 44, html_url: `${inline.html_url}-other-thread`,
    }] }, 'me');
    assert.equal(pr.commentCount, 1, 'resolving one of two threads decrements the badge');
    pr = readPR({ ...feedback, ...resolved, reviewComments: [], comments: [comment(90, inline.created_at)] }, 'me');
    assert.equal(pr.commentCount, 1, 'resolving review threads does not resolve discussion comments');
    pr = readPR({ ...feedback, reviewComments: [], reviews: [{
      id: 1, author: { login: 'reviewer', type: 'User' }, submittedAt: inline.created_at, body: '',
    }] }, 'me');
    assert.equal(pr.comments.length, 0, 'blank review summaries do not displace actual comments');
    pr = readPR({ ...feedback, comments: Array.from({ length: 6 }, (_, i) => comment(i, `2026-11-03T10:0${i}:00Z`, 'review-bot', 'Bot')) }, 'me');
    assert.equal(pr.comments.length, 1, 'newer bot activity does not displace human dock history');
    assert.equal(pr.commentCount, 1, 'bot comments never contribute to the sidebar count');
    pr = readPR({ ...fixture, reviewComments: [inline, { ...inline, id: 43, html_url: `${inline.html_url}-reply` }] }, 'me');
    assert.equal(pr.comments.filter(c => c.at === inline.created_at).length, 2, 'same-timestamp comments remain distinct');
    const space = { id: 'test', name: 'feature' }, repo = { repo: 'fixture' };
    // What the sidebar publishes for one checkout: its branch and the spaces on it.
    const checkout = { ...repo, spaces: [{ id: 'test', name: 'feature' }] };
    view.pr.test = readPR(fixture, view.login);
    view.speak(space, 'test', repo);
    assert.equal(storage.get('github-spaces.comments').test.comments.length, 5);
    const written = cardsWritten.length;
    view.speak(space, 'test', repo);
    assert.equal(cardsWritten.length, written, 'repeat poll does not rewrite the card');
    assert.equal(toasts.length, 0, 'comments never create transient toasts');
    // A PR with no comments yet has no saved card; its first comment must still notify.
    const quiet = { id: 'quiet', name: 'quiet' };
    view.pr.quiet = readPR({ ...fixture, comments: [], reviewComments: [] }, view.login);
    view.speak(quiet, 'quiet', repo);
    const quietToasts = toasts.length;
    view.pr.quiet = readPR({ ...fixture, comments: [comment(50, '2026-11-03T18:00:00Z')], reviewComments: [] }, view.login);
    view.speak(quiet, 'quiet', repo);
    assert.equal(toasts.length, quietToasts + 1, 'the first comment on a comment-free PR notifies');
    const key = JSON.stringify([null, cwd]);
    polledSpaces.push({ ...space, folder: cwd });
    view.git[key] = { ...checkout, branch: 'feature' };
    view.asking = new Set(); view.polled = {};
    view.prSeen.add(key);
    fixture.reviewComments = [inline];
    let failedEndpoint = '';
    githubResponse = args => {
      if (args[0] === 'pr') return { code: 0, stdout: JSON.stringify({ number: 1063, state: 'OPEN', author: fixture.author,
        url: 'https://github.com/test/repo/pull/1063', statusCheckRollup: [{ conclusion: 'FAILURE' }], commits: fixture.commits }) };
      // A known PR is refreshed by number in one GraphQL batch.
      if (args.includes('graphql') && /pullRequest\(number:/.test(args.find(a => String(a).startsWith('query=')) ?? '')) {
        const committedDate = fixture.commits?.[0]?.committedDate ?? '';
        const contexts = { nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }], pageInfo: { hasNextPage: false } };
        const node = {
          number: 1063, url: 'https://github.com/test/repo/pull/1063', state: 'OPEN', mergeable: 'MERGEABLE',
          reviewDecision: '', updatedAt: `u${fixture.comments.length}-${fixture.reviewComments.length}`, headRefName: 'feature', baseRefName: 'main',
          author: fixture.author, commits: { nodes: [{ commit: { committedDate, statusCheckRollup: { contexts } } }] },
        };
        return { code: 0, stdout: JSON.stringify({ data: {
          rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600000).toISOString() },
          repository: { p1063: node },
        } }) };
      }
      assert.ok(args.includes('--paginate') && args.includes('--slurp'));
      if (failedEndpoint && args.some(a => a.includes(failedEndpoint))) return { code: 1, stderr: 'temporary API failure' };
      if (args.includes('graphql')) return { code: 0, stdout: JSON.stringify([
        { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
        { data: { repository: { pullRequest: { reviewThreads: { nodes: fixture.reviewThreads ?? [] } } } } },
      ]) };
      const endpoint = args.find(a => a.startsWith('repos/'));
      const rows = endpoint.includes('/issues/') ? fixture.comments.map(c => ({ ...c, user: c.author, created_at: c.createdAt, html_url: c.url }))
        : endpoint.includes('/reviews?') ? [] : fixture.reviewComments;
      return { code: 0, stdout: JSON.stringify([[], rows]) };
    };
    const tasks = [];
    // Every spawned context can spawn again, as the real host's does: the REST
    // discovery path hands its own cx to the number batch.
    const ctx = () => ({
      notify() {},
      spawn: fn => tasks.push(fn(ctx())),
      timer: { after() {}, every() {} },
    });
    const cx = ctx();
    // Lookups run a few at a time, so a wave may spawn the next one only after
    // the previous settles: drain the queue, not just the promises captured.
    const settle = async () => {
      for (let i = 0; i < 200; i++) {
        if (!tasks.length && !view.queue?.length && !view.running) return;
        await Promise.all(tasks.splice(0));
      }
    };
    view.pollPRs(cx); await settle();
    assert.equal(view.pr[key].comments[0].body, inline.body, 'poll reads inline comments across API pages');
    for (const endpoint of ['issues/', '/reviews?', '/comments?', 'graphql']) {
      failedEndpoint = endpoint;
      fixture.reviewThreads = resolved.reviewThreads;
      tasks.length = 0; view.pollPRs(cx); await settle();
      assert.ok(view.pr[key].commentCount > 0, 'partial activity failure must not clear attention');
      assert.equal(view.pr[key].comments[0].body, inline.body, 'partial failure retains dock history');
      assert.equal(view.pr[key].ci, 'fail', 'CI still refreshes on activity failure');
    }
    failedEndpoint = '';
    fixture.reviewThreads = []; // Unresolve the inline thread for the deck section.
    console.log('PASS background polling, activity pagination, and partial API failures');
    let selected = 'test';
    const dockSource = fs.readFileSync(path.join(__dirname, 'mods/github-spaces/dock.js'), 'utf8')
      .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
    const commentCard = vm.runInNewContext(`${dockSource}\ncommentCard`, {
      div: () => element('div'), h_flex: () => element('row'), v_flex: () => element('column'),
      focused: () => ({ space: selected }), theme: () => ({}),
      shared: k => storage.get(k), setShared: (k, v) => storage.set(k, v),
    }, { timeout: 1000 });
    const shown = () => [0, 1, 2, 3, 4].filter(s => commentCard(s).items.length).length; // blocks with content
    const closeTop = () => commentCard(0).items[0].items[1].on_click({}, { stop_propagation() {} });
    const bodyOf = s => commentCard(s).items[2].items[0];
    const badgeOf = () => view.pr[key].commentCount;
    assert.equal(shown(), 5, 'five comments render as five independent cards');
    assert.ok(String(commentCard(4).items[0].items[0].items[0]).startsWith('reviewer · '), 'each slot is its own card with its own comment');
    assert.ok(String(commentCard(0).items[1].items[0]).includes('4 more behind'), 'top card counts the others');
    assert.equal(badgeOf(), 8, 'the published count covers all pending comments');
    const card = storage.get('github-spaces.comments').test;
    const urls = [];
    commentCard(0).items[3].items[0].on_click({}, { stop_propagation() {}, open_url: url => urls.push(url) });
    assert.equal(urls[0], card.comments[0].url, 'comment link opens its exact GitHub URL');
    assert.equal(shown(), 5, 'opening a link does not dismiss the card');
    fixture.commits = [{ authors: [{ login: 'me' }], committedDate: '2099-01-01T00:00:00Z' }];
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(view.pr[key].commentCount, 0, 'a newer commit clears sidebar attention');
    assert.equal(shown(), 5, 'a new commit keeps the cards');
    fixture.commits = [];
    tasks.length = 0; view.pollPRs(cx); await settle();
    selected = 'other';
    assert.equal(shown(), 0, 'other worktree shows nothing');
    selected = 'test';
    closeTop();
    assert.equal(shown(), 4, 'closing slot 0 leaves the rest');
    assert.ok(storage.get('github-spaces.comments').test.dismissedIds.includes(card.comments[0].id), 'comment dismissal is persisted');
    assert.equal(badgeOf(), 8, 'closing a card is the sidebar\'s subtraction, not a new count here');
    view.speak(space, key, repo);
    assert.equal(shown(), 4, 'repeat poll does not reopen a closed comment');
    fixture.comments.push(comment(9, '2026-11-03T12:00:00Z'));
    const toasted = toasts.length;
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(view.pr[key].commentCount, 9, 'new feedback raises the raw count');
    assert.equal(toasts.length, toasted + 1, 'a new human comment notifies once');
    assert.match(toasts.at(-1).title, /commented/);
    assert.match(toasts.at(-1).body, /Comment 9/, 'the toast names the new comment');
    assert.equal(toasts.at(-1).action.args.id, 'test', 'the toast opens the space');
    assert.equal(badgeOf(), 9, 'new feedback counts in the published attention list');
    closeTop();
    assert.equal(badgeOf(), 9, 'a dismissed card stays in the published attention list');
    // A close click targets the original comment even if newer activity arrived.
    fixture.comments.push(comment(10, '2026-11-03T13:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await settle();
    const staleClose = commentCard(0).items[0].items[1].on_click;
    fixture.comments.push(comment(11, '2026-11-03T14:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await settle();
    const before = shown();
    staleClose({}, { stop_propagation() {} });
    assert.equal(bodyOf(0), 'Comment 11', 'newest comment stays in slot 0');
    assert.equal(shown(), before - 1, 'old close callback dismisses only its original comment');
    while (shown() > 1) closeTop();
    assert.equal(shown(), 1, 'last comment shows alone');
    closeTop();
    assert.equal(shown(), 0, 'empty slots render nothing after the last close');
    fixture.comments.push(comment(12, '2026-11-03T15:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(shown(), 1, 'only the new comment appears');
    const saved = storage.get('github-spaces.comments');
    storage.set('github-spaces.comments', { ...saved, test: { ...saved.test, dismissed: true, dismissedIds: undefined } });
    assert.equal(shown(), 0, 'legacy whole-dock dismissal stays respected');
    fixture.comments.push(comment(13, '2026-11-03T16:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(shown(), 1, 'migration keeps old cards closed when a new comment arrives');
    // One repo, on demand: every branch there is asked again, and only that repo.
    storage.set('spaces.git', { [key]: { ...checkout, branch: 'feature', on: null } });
    view.git[key] = { ...checkout, branch: 'feature', on: null };
    const otherKey = JSON.stringify([null, '/other']);
    view.git[otherKey] = { repo: 'other', branch: 'x', on: null, spaces: [{ id: 'o', name: 'o' }] };
    view.prNum[otherKey] = { number: 7, url: 'https://github.com/o/o/pull/7', branch: 'x', open: true, at: Date.now() };
    view.asking = new Set(); view.polled = {};
    let refreshAsked = 0; const gh = githubResponse;
    const isPoll = args => args[0] === 'pr' || (args.includes('graphql') && /pullRequest\(number:\d/.test(args.find(a => String(a).startsWith('query=')) ?? ''));
    githubResponse = args => { if (isPoll(args)) refreshAsked++; return gh(args); };
    tasks.length = 0; view.refreshRepo('fixture', cx); await settle();
    assert.equal(refreshAsked, 1, 'a repo refresh asks its branch again');
    assert.ok(view.prNum[otherKey], 'another repo\'s cached PR is untouched');
    refreshAsked = 0; view.asking = new Set();
    tasks.length = 0; view.refreshRepo('fixture', cx); await settle();
    assert.equal(refreshAsked, 1, 'a second on-demand refresh asks again instead of throttling');
    delete view.git[otherKey];
    githubResponse = gh;
    assert.equal(toasts.at(-1).timeout, 15000, 'comment toasts stay up for 15 seconds');
    // A reload forgets what it saw: a comment that arrived meanwhile still notifies, once.
    view.prSeen.delete(key);
    fixture.comments.push(comment(14, '2026-11-03T17:00:00Z'));
    const beforeReload = toasts.length;
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(toasts.length, beforeReload + 1, 'a comment missed while the mod was reloaded notifies after the reload');
    // After the git refresh, only spaces without PR data are polled.
    view.asking = new Set(); view.pr = {};
    let asked = 0; const realExec = githubResponse;
    githubResponse = args => { if (isPoll(args)) asked++; return realExec(args); };
    tasks.length = 0; view.pollPRs(cx, k => !(k in view.pr)); await settle();
    assert.equal(asked, 1, 'the missing PR is fetched right away');
    assert.ok(view.pr[key], 'its mark is back');
    asked = 0; view.asking = new Set();
    tasks.length = 0; view.pollPRs(cx, k => !(k in view.pr)); await settle();
    assert.equal(asked, 0, 'spaces that already have PR data are not polled again');
    githubResponse = realExec;
    console.log('PASS independent cards, per-card dismissal, badge decrement, links, scope, and migration');

    // A legacy status context reports state, not conclusion.
    const ciOf = (entry) => readPR({ number: 1, state: 'OPEN', statusCheckRollup: [entry] }).ci;
    assert.equal(ciOf({ state: 'FAILURE' }), 'fail', 'legacy failing status');
    assert.equal(ciOf({ state: 'PENDING' }), 'run', 'legacy pending status');
    assert.equal(ciOf({ state: 'SUCCESS' }), 'pass', 'legacy passing status');
    assert.equal(ciOf({ status: 'COMPLETED', conclusion: 'SUCCESS' }), 'pass', 'check run still passes');
    console.log('PASS legacy status contexts classify like check runs');

    const realGh = githubResponse;
    const reset = () => {
      view.pr = {}; view.act = {}; view.prNum = {}; view.retry = {}; view.tries = {};
      view.ghDead = {}; view.holdUntil = 0; view.prSeen = new Set(); view.mergedDone = new Set();
      view.asking = new Set(); view.polled = {};
      view.git[key] = { ...checkout, branch: 'feature' };
      polledSpaces.length = 0;
      polledSpaces.push({ id: 'test', name: 'feature', folder: cwd });
    };
    const url1063 = 'https://github.com/test/repo/pull/1063';
    const node = (extra = {}) => ({
      number: 1063, url: url1063, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: '',
      updatedAt: '2026-11-03T09:00:00Z', headRefName: 'feature', author: { login: 'me' },
      commits: { nodes: [{ commit: { committedDate: '2026-11-03T08:00:00Z', statusCheckRollup: { contexts: {
        nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
        pageInfo: { hasNextPage: false },
      } } } }] },
      ...extra,
    });
    const batchAnswer = (aliases, limit = { remaining: 4000, resetAt: new Date(Date.now() + 3600000).toISOString() }) =>
      JSON.stringify({ data: { rateLimit: limit, repository: aliases } });
    const isBatch = (args) => /pullRequest\(number:\d/.test(args.find(a => String(a).startsWith('query=')) ?? '');

    // One batched query refreshes a known PR instead of gh's branch lookup.
    reset();
    fixture.reviewComments = [inline]; fixture.reviewThreads = []; fixture.commits = [];
    view.prNum[key] = { number: 1063, url: url1063, branch: 'feature', open: true, at: Date.now() };
    let batchCalls = 0, activityCalls = 0;
    githubResponse = args => {
      if (isBatch(args)) { batchCalls++; return { code: 0, stdout: batchAnswer({ p1063: node() }) }; }
      if (args[0] === 'api' && !args.includes('graphql')) activityCalls++;
      return realGh(args);
    };
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(batchCalls, 1, 'one query carries every known PR in the repo');
    assert.equal(view.pr[key].ci, 'fail', 'the batched status is published');
    assert.equal(view.prNum[key].number, 1063);
    assert.equal(activityCalls, 3, 'a new PR still reads its three activity lists');
    console.log('PASS one batched query refreshes a known PR');

    // Unchanged updatedAt: no activity lists at all.
    activityCalls = 0; batchCalls = 0;
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(batchCalls, 1);
    assert.equal(activityCalls, 0, 'an unchanged PR skips the three activity lists');
    console.log('PASS unchanged PR skips activity');


    // Resolution is re-read even though updatedAt did not move.
    const attentionBefore = view.pr[key].commentCount;
    let threadCalls = 0, activityAfter = 0;
    githubResponse = args => {
      if (isBatch(args)) return { code: 0, stdout: batchAnswer({ p1063: node() }) };
      if (args.includes('graphql')) {
        threadCalls++;
        return { code: 0, stdout: JSON.stringify([{ data: { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600000).toISOString() },
          repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 42 }] } }], pageInfo: { hasNextPage: false } } } } } }]) };
      }
      if (args[0] === 'api') activityAfter++;
      return realGh(args);
    };
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(threadCalls, 1, 'threads are asked about while a badge shows');
    assert.equal(activityAfter, 0, 'and the activity lists still are not');
    assert.equal(view.pr[key].commentCount, attentionBefore - 1, 'resolving the thread clears its comment without a push');
    assert.ok(storage.get('github-spaces.comments').test.comments.length > 0, 'the cards stay after resolution');
    console.log('PASS resolution is re-read without an updatedAt change');

    // A branch with no cached number: one REST list call finds its PR, then one
    // number batch carries the status. Not `gh pr view` per branch.
    reset();
    view.git[key] = { ...view.git[key], slug: 'test/repo' };
    let restLists = 0, numberBatches = 0;
    githubResponse = args => {
      if (args[0] === 'api' && args.some(a => String(a).includes('/pulls?state=all'))) {
        restLists++;
        return { code: 0, stdout: JSON.stringify([[{ number: 1063, html_url: url1063, state: 'open',
          head: { ref: 'feature' }, updated_at: '2026-11-03T09:00:00Z' }]]) };
      }
      if (isBatch(args)) { numberBatches++; return { code: 0, stdout: batchAnswer({ p1063: node({ baseRefName: 'main' }) }) }; }
      return realGh(args);
    };
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(restLists, 1, 'one REST list discovers the branch\'s PR');
    assert.equal(numberBatches, 1, 'one number batch carries its status');
    assert.equal(view.pr[key].number, 1063, 'the discovered PR is published');
    assert.equal(view.pr[key].base, 'main', 'its base branch comes back for stacking');
    console.log('PASS REST discovery plus one number batch');

    // An empty page (fewer than 100 PRs) means this branch has no PR.
    view.pr = {}; view.prNum = {}; view.asking = new Set(); view.lastPrs = undefined; view.published = null;
    githubResponse = args => (args[0] === 'api' && args.some(a => String(a).includes('/pulls?state=all')))
      ? { code: 0, stdout: JSON.stringify([[]]) } : realGh(args);
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(view.pr[key], null, 'a short page clears the mark for a branch with no PR');
    githubResponse = realGh;
    console.log('PASS a branch absent from a short REST page has no PR');

    // A late answer for a branch the person already left is dropped.
    reset();
    githubResponse = args => {
      if (args[0] === 'pr') {
        view.git[key] = { ...view.git[key], branch: 'moved-on' };
        return { code: 0, stdout: JSON.stringify({ number: 8, url: 'https://github.com/test/repo/pull/8', state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], author: { login: 'me' }, commits: [], reviewDecision: '' }) };
      }
      return realGh(args);
    };
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(view.pr[key], undefined, 'a late answer is not written onto the new branch');
    assert.equal(view.polled[key], undefined, 'and it does not throttle the next look');
    console.log('PASS a late answer never lands on a moved branch');

    // A restart whose activity read fails keeps the saved cards.
    reset();
    storage.set('github-spaces.comments', { test: { pr: 'fixture#1063', at: '', revision: 'x', title: 'PR #1063 · test',
      comments: [{ id: 'u1', at: '2026-11-03T07:00:00Z', author: 'rev', body: 'b', url: 'u1' }],
      attentionIds: ['u1'], dismissedIds: [] } });
    failedEndpoint = 'comments';
    githubResponse = args => (args[0] === 'pr' ? { code: 0, stdout: JSON.stringify({ number: 1063, url: url1063, state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'FAILURE' }], author: { login: 'me' }, commits: [], reviewDecision: '' }) } : realGh(args));
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(storage.get('github-spaces.comments').test.comments.length, 1, 'a failed first read keeps the saved cards');
    assert.equal(storage.get('github-spaces.comments').test.attentionIds.length, 1, 'and their count');
    assert.equal(view.pr[key].ci, 'fail', 'while the checks still refresh');
    failedEndpoint = '';
    console.log('PASS a failed activity read never erases saved cards');

    // A confirmed no-PR hides the dock; a failure never does.
    reset();
    storage.set('github-spaces.comments', { test: { pr: 'fixture#1063', comments: [{}], attentionIds: [], dismissedIds: [] } });
    githubResponse = args => (args[0] === 'pr' ? { code: 1, stderr: 'no pull requests found for branch "feature"' } : realGh(args));
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.equal(view.pr[key], null, 'no PR clears the mark');
    assert.equal(storage.get('github-spaces.comments').test, undefined, 'and hides its dock');
    console.log('PASS a confirmed no-PR hides the dock');

    // An exhausted budget pauses polling and keeps every mark.
    reset();
    view.pr[key] = readPR(fixture, view.login);
    githubResponse = () => ({ code: 1, stderr: 'GraphQL: API rate limit already exceeded' });
    tasks.length = 0; view.pollPRs(cx); await settle();
    assert.ok(view.holdUntil > Date.now(), 'an exhausted budget stops the next poll');
    assert.ok(view.pr[key]?.number === 1063, 'marks are kept, not cleared');
    githubResponse = realGh;
    console.log('PASS rate limit pauses polling and keeps marks');

    // Two spaces in one checkout each get their own dock.
    reset();
    storage.set('github-spaces.comments', {});
    view.git[key] = { ...view.git[key], spaces: [{ id: 'test', name: 'feature' }, { id: 'test2', name: 'feature two' }] };
    githubResponse = realGh;
    tasks.length = 0; view.pollPRs(cx); await settle();
    const cards = storage.get('github-spaces.comments');
    assert.ok(cards.test && cards.test2, 'both spaces on one checkout are written');
    console.log('PASS two spaces on one checkout both get cards');

    // A reload keeps the last marks until fresh answers arrive; a confirmed
    // no-PR still removes one.
    reset();
    storage.set('github-spaces.prs', { 'fixture|feature': { number: 1063, state: 'OPEN', attentionIds: [] } });
    view.pr = {};
    view.lastPrs = undefined; view.published = null;
    view.publish();
    assert.ok(storage.get('github-spaces.prs')['fixture|feature'], 'a reload does not blank unpublished marks');
    view.pr[key] = null;
    view.wroteAt = 0; // the 1s write gap would otherwise hold this one
    view.publish();
    assert.equal(storage.get('github-spaces.prs')['fixture|feature'], undefined, 'a confirmed no-PR drops its mark');
    console.log('PASS a reload keeps marks and a no-PR still clears one');

    // A branch swapped under the same checkout (the picker does this) must not
    // publish the old branch's answer under the new branch.
    reset();
    view.pr[key] = readPR(fixture, view.login);
    view.git[key] = { ...checkout, branch: 'feature', repo: 'fixture' };
    storage.set('spaces.git', { [key]: { ...checkout, branch: 'switched', repo: 'fixture' } });
    storage.set('github-spaces.prs', { 'fixture|feature': { number: 1063, state: 'OPEN', attentionIds: [] } });
    view.asked = null; view.lastPrs = undefined; view.published = null;
    view.sync(cx);
    assert.equal(view.pr[key], undefined, 'the old branch\'s answer is dropped');
    assert.equal(storage.get('github-spaces.prs')['fixture|switched'], undefined, 'and never published under the new branch');
    console.log('PASS a branch switch clears the old answer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
