const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Record native builder output without needing a running Herdr window.
function element(kind) {
  const node = { kind, children: [] };
  let proxy;
  proxy = new Proxy(node, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === 'when') { if (args[0]) args[1](proxy); }
        else if (key === 'child') {
          assert.ok(args[0] != null, 'native child cannot be null');
          target.children.push(args[0]);
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
    const notifications = [];
    const storage = new Map();
    const polledSpaces = [];
    const source = fs.readFileSync(path.join(__dirname, 'mods/github-spaces/main.js'), 'utf8')
      .replace(/^import .*;$/gm, '').replace(/export default class /, 'class ').replace(/^export /gm, '');
    const { Spaces, readPR } = vm.runInNewContext(`${source}\n({ Spaces, readPR })`, {
      View: class {}, div: () => element('div'), h_flex: () => element('row'),
      svg: (p) => element(p), exec,
      notify: n => notifications.push(n),
      shared: k => storage.get(k),
      setShared: (k, v) => { storage.set(k, v); const card = Object.values(v).at(-1); notifications.push(card); },
      localStorage: { setItem: (k, v) => storage.set(k, v) },
      spaces: () => polledSpaces, panes: () => [], window: () => ({ active: false }),
    }, { timeout: 1000 });
    const view = new Spaces();
    view.git = {}; view.checked = {}; view.unsure = new Set(); view.rebasing = {};
    view.watch = () => {}; // No filesystem watcher in a one-shot test.
    view.commentRead = {};
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
      assert.ok(mark.children[0].kind.endsWith(`/${icon}.svg`), name);
      assert.equal(mark.children[0].text_color, color, name);
      if (icon === 'conflict') {
        assert.match(mark.tooltip, /merge conflicts/);
        assert.equal(Object.hasOwn(mark.children[0], 'spin'), false, 'conflict icon must not spin');
      }
      console.log(`PASS ${name}`);
    }
    view.prSeen = new Set(); view.pr = {}; view.commentSeen = {}; view.mergedDone = new Set();
    view.login = 'me';
    const fixture = {
      number: 1063, state: 'OPEN',
      comments: [{ author: { login: 'other' }, createdAt: '2026-11-01T00:00:00Z', body: 'old' }],
    };
    const space = { id: 'test', name: 'feature' }, repo = { repo: 'fixture' };
    view.pr.test = readPR(fixture, view.login);
    view.speak(space, 'test', repo);
    assert.equal(notifications.length, 1, 'first look creates a persistent card');
    fixture.reviews = [{ author: { login: 'reviewer' }, submittedAt: '2026-11-03T07:01:03Z', body: '' }];
    fixture.reviewComments = [{ user: { login: 'reviewer' }, created_at: '2026-11-03T07:01:03Z', body: 'Please fix this line' }];
    fixture.comments.push({ author: { login: 'me' }, createdAt: '2026-11-03T07:02:00Z', body: 'my reply' });
    view.pr.test = readPR(fixture, view.login);
    view.speak(space, 'test', repo);
    assert.equal(notifications.length, 2, 'inline review notifies even when followed by own comment');
    assert.match(notifications[1].body, /reviewer: Please fix this line/);
    assert.equal(view.prMark(view.pr.test, repo, {}).children.length, 2, 'review leaves unread bubble');
    view.speak(space, 'test', repo);
    assert.equal(notifications.length, 2, 'same review only notifies once');
    assert.equal(JSON.parse(storage.get('pr.comment.seen'))['fixture#1063'], '2026-11-03T07:01:03Z');
    view.readPrComments({ k: 'test', g: repo });
    assert.equal(view.prMark(view.pr.test, repo, {}).children.length, 1, 'row click clears bubble');
    fixture.reviewComments.push({ user: { login: 'reviewer' }, created_at: '2026-11-03T08:00:00Z', body: 'New inline reply' });
    view.pr.test = readPR(fixture, view.login); view.speak(space, 'test', repo);
    assert.equal(notifications.length, 3, 'inline reply on an existing review notifies');
    fixture.reviews.push({ author: { login: 'reviewer' }, submittedAt: '2026-11-03T09:00:00Z', body: '' });
    view.pr.test = readPR(fixture, view.login); view.speak(space, 'test', repo);
    assert.equal(notifications.length, 4, 'submitted review without summary also notifies');
    console.log('PASS review notifications, replies, own-comment filtering, persistence, and unread bubble');
    const key = JSON.stringify([null, cwd]);
    polledSpaces.push({ ...space, folder: cwd });
    view.git[key] = { ...repo, branch: 'feature' };
    view.asking = new Set(); view.ghAway = {};
    view.prSeen.add(key);
    fixture.reviewComments.push({ user: { login: 'reviewer' }, created_at: '2026-11-03T10:00:00Z', body: 'Paginated inline reply' });
    let failInline = false;
    githubResponse = args => {
      if (args[0] === 'pr') return { code: 0, stdout: JSON.stringify({ ...fixture, reviewComments: undefined, url: 'https://github.com/test/repo/pull/1063' }) };
      assert.ok(args.includes('--paginate') && args.includes('--slurp'));
      return failInline ? { code: 1, stderr: 'temporary API failure' }
        : { code: 0, stdout: JSON.stringify([[], fixture.reviewComments]) };
    };
    const tasks = [];
    const cx = { spawn: fn => tasks.push(fn({ notify() {} })) };
    view.pollPRs(cx); await Promise.all(tasks);
    assert.equal(view.pr[key].commentHead, 'Paginated inline reply', 'poll reads inline comments across API pages');
    const delivered = notifications.length;
    assert.equal(delivered, 5, 'background poll delivers review notification');
    failInline = true;
    tasks.length = 0; view.pollPRs(cx); await Promise.all(tasks);
    assert.equal(view.pr[key].commentHead, 'Paginated inline reply', 'API failure retains unread inline comment');
    assert.equal(notifications.length, delivered, 'partial failure does not repeat the notification');
    console.log('PASS background review polling, pagination, and partial API failure');
    let selected = 'test';
    const dockSource = fs.readFileSync(path.join(__dirname, 'mods/github-spaces/dock.js'), 'utf8')
      .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
    const dock = vm.runInNewContext(`${dockSource}\ncommentDock`, {
      div: () => element('div'), h_flex: () => element('row'), v_flex: () => element('column'),
      focused: () => ({ space: selected }), theme: () => ({}),
      shared: k => storage.get(k), setShared: (k, v) => storage.set(k, v),
    }, { timeout: 1000 });
    assert.equal(dock().children.length, 3, 'selected worktree shows its card');
    selected = 'other';
    assert.equal(dock().children.length, 0, 'other worktree hides the card');
    selected = 'test';
    dock().children[0].children[1].on_click({}, { stop_propagation() {} });
    assert.equal(dock().children.length, 0, 'dismissed card stays hidden');
    view.speak(space, key, repo);
    assert.equal(dock().children.length, 0, 'repeat poll does not reopen dismissed card');
    console.log('PASS dock worktree scope and persistent dismissal');
    async function verify(name, ahead, behind, red) {
      await view.check(key, {});
      const g = view.git[key];
      assert.ok(g, `${name}: git state loaded`);
      assert.deepEqual([g.ahead, g.behind], [ahead, behind], name);
      const button = view.fetchButton({ id: 'test' }, g, { ansi4: 'blue' });
      assert.equal(button.children[0].text_color, red ? '#ef4444' : 'blue', name);
      assert.equal(button.children.length, red ? 2 : 1, `${name}: badge visibility`);
      if (red) assert.equal(button.children[1].children[0], String(behind));
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
