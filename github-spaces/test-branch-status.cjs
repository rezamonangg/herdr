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
  const git = (...args) => {
    const r = exec('git', args);
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    const cardsWritten = [];
    const toasts = [];
    const storage = new Map();
    const polledSpaces = [];
    const source = fs.readFileSync(path.join(__dirname, 'mods/github-spaces/main.js'), 'utf8')
      .replace(/^import .*;$/gm, '').replace(/export default class /, 'class ').replace(/^export /gm, '');
    const { Spaces, readPR } = vm.runInNewContext(`${source}\n({ Spaces, readPR })`, {
      View: class {}, div: () => element('div'), h_flex: () => element('row'),
      svg: (p) => element(p), exec,
      notify: n => toasts.push(n),
      shared: k => storage.get(k),
      setShared: (k, v) => { storage.set(k, v); cardsWritten.push(v); },
      localStorage: { setItem: (k, v) => storage.set(k, v) },
      spaces: () => polledSpaces, panes: () => [], window: () => ({ active: false }),
    }, { timeout: 1000 });
    const view = new Spaces();
    view.git = {}; view.checked = {}; view.unsure = new Set(); view.rebasing = {};
    view.watch = () => {}; // No filesystem watcher in a one-shot test.
    for (const [name, state, mergeable, ci, icon, color] of [
      ['conflict beats passing CI', 'OPEN', 'CONFLICTING', 'SUCCESS', 'conflict', '#f97316'],
      ['conflict beats running CI', 'OPEN', 'CONFLICTING', 'QUEUED', 'conflict', '#f97316'],
      ['conflict beats failed CI', 'OPEN', 'CONFLICTING', 'FAILURE', 'conflict', '#f97316'],
      ['merged beats conflict', 'MERGED', 'CONFLICTING', 'SUCCESS', 'circle-check', '#a78bfa'],
      ['closed beats conflict', 'CLOSED', 'CONFLICTING', 'SUCCESS', 'minus', 'dim'],
      ['unknown is not conflict', 'OPEN', 'UNKNOWN', 'SUCCESS', 'circle-check', '#22c55e'],
      ['resolved conflict restores CI', 'OPEN', 'MERGEABLE', 'FAILURE', 'x', '#ef4444'],
    ]) {
      const pr = readPR({ number: 1, state, mergeable, statusCheckRollup: [{ conclusion: ci }] });
      const mark = view.prMark(pr, { repo: 'test' }, { dim: 'dim' });
      assert.ok(mark.items[0].kind.endsWith(`/${icon}.svg`), name);
      assert.equal(mark.items[0].text_color, color, name);
      if (icon === 'conflict') {
        assert.match(mark.tooltip, /merge conflicts/);
        assert.equal(Object.hasOwn(mark.items[0], 'spin'), false, 'conflict icon must not spin');
      }
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
    const badge = view.prMark(pr, {}, {}).items[2];
    assert.equal(badge.items[1].items[0], '7', 'sidebar renders a number beside the comment icon');
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
      assert.equal(pr.commentCount > 0, expected, name);
      assert.equal(view.prMark(pr, {}, {}).items.length, expected ? 3 : 2, `${name}: sidebar rendering`);
      assert.equal(pr.comments.length, name.includes('bot') ? 0 : 1, `${name}: dock excludes bots but keeps resolved human history`);
      console.log(`PASS ${name}`);
    }
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
    view.pr.test = readPR(fixture, view.login);
    view.speak(space, 'test', repo);
    assert.equal(storage.get('github-spaces.comments').test.comments.length, 5);
    const written = cardsWritten.length;
    view.speak(space, 'test', repo);
    assert.equal(cardsWritten.length, written, 'repeat poll does not rewrite the card');
    assert.equal(toasts.length, 0, 'comments never create transient toasts');
    const key = JSON.stringify([null, cwd]);
    polledSpaces.push({ ...space, folder: cwd });
    view.git[key] = { ...repo, branch: 'feature' };
    view.asking = new Set(); view.ghAway = {};
    view.prSeen.add(key);
    fixture.reviewComments = [inline];
    let failedEndpoint = '';
    githubResponse = args => {
      if (args[0] === 'pr') return { code: 0, stdout: JSON.stringify({ number: 1063, state: 'OPEN', author: fixture.author,
        url: 'https://github.com/test/repo/pull/1063', statusCheckRollup: [{ conclusion: 'FAILURE' }], commits: fixture.commits }) };
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
    const cx = { spawn: fn => tasks.push(fn({ notify() {} })) };
    view.pollPRs(cx); await Promise.all(tasks);
    assert.equal(view.pr[key].comments[0].body, inline.body, 'poll reads inline comments across API pages');
    for (const endpoint of ['issues/', '/reviews?', '/comments?', 'graphql']) {
      failedEndpoint = endpoint;
      fixture.reviewThreads = resolved.reviewThreads;
      tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
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
    const badgeOf = () => view.prMark(view.pr[key], repo, {}, 'test').items[2];
    assert.equal(shown(), 5, 'five comments render as five independent cards');
    assert.ok(String(commentCard(4).items[0].items[0].items[0]).startsWith('reviewer · '), 'each slot is its own card with its own comment');
    assert.ok(String(commentCard(0).items[1].items[0]).includes('4 more behind'), 'top card counts the others');
    assert.equal(badgeOf().items[1].items[0], '8', 'sidebar badge counts all pending comments');
    const card = storage.get('github-spaces.comments').test;
    const urls = [];
    commentCard(0).items[3].items[0].on_click({}, { stop_propagation() {}, open_url: url => urls.push(url) });
    assert.equal(urls[0], card.comments[0].url, 'comment link opens its exact GitHub URL');
    assert.equal(shown(), 5, 'opening a link does not dismiss the card');
    fixture.commits = [{ authors: [{ login: 'me' }], committedDate: '2099-01-01T00:00:00Z' }];
    tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
    assert.equal(view.pr[key].commentCount, 0, 'a newer commit clears sidebar attention');
    assert.equal(shown(), 5, 'a new commit keeps the cards');
    fixture.commits = [];
    tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
    selected = 'other';
    assert.equal(shown(), 0, 'other worktree shows nothing');
    selected = 'test';
    closeTop();
    assert.equal(shown(), 4, 'closing slot 0 leaves the rest');
    assert.ok(storage.get('github-spaces.comments').test.dismissedIds.includes(card.comments[0].id), 'comment dismissal is persisted');
    assert.equal(badgeOf().items[1].items[0], '7', 'closing a card decrements the sidebar badge');
    view.speak(space, key, repo);
    assert.equal(shown(), 4, 'repeat poll does not reopen a closed comment');
    fixture.comments.push(comment(9, '2026-11-03T12:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
    assert.equal(view.pr[key].commentCount, 9, 'new feedback raises the raw count');
    assert.equal(badgeOf().items[1].items[0], '8', 'new feedback counts, closed comments do not return');
    closeTop();
    assert.equal(badgeOf().items[1].items[0], '7', 'closing the newest pending card lowers the badge');
    // A close click targets the original comment even if newer activity arrived.
    fixture.comments.push(comment(10, '2026-11-03T13:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
    const staleClose = commentCard(0).items[0].items[1].on_click;
    fixture.comments.push(comment(11, '2026-11-03T14:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
    const before = shown();
    staleClose({}, { stop_propagation() {} });
    assert.equal(bodyOf(0), 'Comment 11', 'newest comment stays in slot 0');
    assert.equal(shown(), before - 1, 'old close callback dismisses only its original comment');
    while (shown() > 1) closeTop();
    assert.equal(shown(), 1, 'last comment shows alone');
    closeTop();
    assert.equal(shown(), 0, 'empty slots render nothing after the last close');
    fixture.comments.push(comment(12, '2026-11-03T15:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
    assert.equal(shown(), 1, 'only the new comment appears');
    const saved = storage.get('github-spaces.comments');
    storage.set('github-spaces.comments', { ...saved, test: { ...saved.test, dismissed: true, dismissedIds: undefined } });
    assert.equal(shown(), 0, 'legacy whole-dock dismissal stays respected');
    fixture.comments.push(comment(13, '2026-11-03T16:00:00Z'));
    tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
    assert.equal(shown(), 1, 'migration keeps old cards closed when a new comment arrives');
    console.log('PASS independent cards, per-card dismissal, badge decrement, links, scope, and migration');
    async function verify(name, ahead, behind, red) {
      await view.check(key, {});
      const g = view.git[key];
      assert.ok(g, `${name}: git state loaded`);
      assert.deepEqual([g.ahead, g.behind], [ahead, behind], name);
      const button = view.fetchButton({ id: 'test' }, g, { ansi4: 'blue' });
      assert.equal(button.items[0].text_color, red ? '#ef4444' : 'blue', name);
      assert.equal(button.items.length, red ? 2 : 1, `${name}: badge visibility`);
      if (red) assert.equal(button.items[1].items[0], String(behind));
      if (ahead && behind) {
        assert.match(button.tooltip, /diverged/);
        assert.doesNotMatch(button.tooltip, /push after rebase/, 'divergence cannot prescribe a push');
      }
      console.log(`PASS ${name}: ahead ${ahead}, behind ${behind}`);
    }
    git('init', '--bare', path.join(dir, 'origin.git'));
    git('init', '-b', 'main');
    git('config', 'user.name', 'Mod test');
    git('config', 'user.email', 'mod-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('remote', 'add', 'origin', path.join(dir, 'origin.git'));
    git('commit', '--allow-empty', '-m', 'root');
    git('push', '-u', 'origin', 'main');
    git('checkout', '-b', 'feature');
    fs.writeFileSync(path.join(cwd, 'feature.txt'), 'feature\n');
    git('add', '.'); git('commit', '-m', 'feature'); git('push', '-u', 'origin', 'feature');
    await verify('up to date', 0, 0, false);
    fs.writeFileSync(path.join(cwd, 'remote.txt'), 'remote\n');
    git('add', '.'); git('commit', '-m', 'remote change'); git('push');
    git('reset', '--hard', 'HEAD~'); // Only this disposable fixture, never a user's checkout.
    await verify('strictly behind', 0, 1, true);
    git('merge', '--ff-only', '@{upstream}');
    fs.writeFileSync(path.join(cwd, 'local.txt'), 'local\n');
    git('add', '.'); git('commit', '-m', 'unpublished change');
    await verify('ahead only', 1, 0, false);
    const upstream = git('rev-parse', '@{upstream}');
    const independent = git('commit-tree', 'HEAD^{tree}', '-p', upstream, '-m', 'independent remote commit');
    git('update-ref', 'refs/remotes/origin/feature', independent);
    await verify('independent local and remote commits', 1, 1, false);
    git('update-ref', 'refs/remotes/origin/feature', upstream);
    git('checkout', 'main');
    fs.writeFileSync(path.join(cwd, 'base.txt'), 'updated base\n');
    git('add', '.'); git('commit', '-m', 'advance base'); git('push');
    git('checkout', 'feature'); git('rebase', 'origin/main');
    await verify('rebased onto main, not pushed', 4, 2, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
