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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-stacks-test-'));
  const cwd = path.join(dir, 'checkout');
  fs.mkdirSync(cwd);
  const exec = (cmd, args, options = {}) => {
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
    const storage = new Map();
    const moves = [];
    const source = fs.readFileSync(path.join(__dirname, 'mods/spaces-stacks/main.js'), 'utf8')
      .replace(/^import .*;$/gm, '').replace(/export default class /, 'class ').replace(/^export /gm, '');
    const shared = k => storage.get(k);
    const setShared = (k, v) => storage.set(k, v);
    let spaces = [];
    const { Spaces } = vm.runInNewContext(`${source}\n({ Spaces })`, {
      View: class {}, div: () => element('div'), h_flex: () => element('row'), v_flex: () => element('col'),
      svg: (p) => element(p), exec, shared, setShared,
      run: (name, args) => { moves.push([name, args]); return null; },
      notify: () => null, theme: () => ({}), machines: () => [], window: () => ({ active: false }),
      spaces: () => spaces, panes: () => [], layout: () => null, props: () => ({}), closeOverlay: () => null,
      localStorage: { setItem() {}, getItem: () => null },
    }, { timeout: 1000 });
    const view = new Spaces();
    view.git = {}; view.checked = {}; view.unsure = new Set(); view.pending = new Set();
    view.busy = {}; view.ready = {}; view.at = {}; view.born = {}; view.machines = [];
    view.folded = new Set(); view.reconnecting = {}; view.rebasing = {};
    view.shown = new Set(spaces.map(s => s.id));
    view.publish = view.publish.bind(view);

    const t = { dim: 'dim', foreground: 'fg' };

    // --- one repo: main + a two-deep stack + one worktree based on main ---
    const repo = JSON.stringify([null, '/repo/.git']);
    spaces = [
      { id: 'main', name: 'repo', folder: '/repo' },
      { id: 'a', name: 'stack/1', folder: '/repo-1' },
      { id: 'b', name: 'stack/2', folder: '/repo-2' },
      { id: 'c', name: 'fix', folder: '/repo-3' },
    ];
    view.shown = new Set(spaces.map(s => s.id));
    view.git = {
      [JSON.stringify([null, '/repo'])]: { name: 'repo', branch: 'main', ahead: 0, behind: 0, repo, linked: false },
      [JSON.stringify([null, '/repo-1'])]: { name: 'repo', branch: 'stack/1', ahead: 0, behind: 0, repo, linked: true },
      [JSON.stringify([null, '/repo-2'])]: { name: 'repo', branch: 'stack/2', ahead: 0, behind: 0, repo, linked: true },
      [JSON.stringify([null, '/repo-3'])]: { name: 'repo', branch: 'fix', ahead: 0, behind: 0, repo, linked: true },
    };
    const pr = (branch, base, extra = {}) => ({
      number: branch.length, url: `https://github.com/o/r/pull/${branch.length}`, state: 'OPEN',
      conflict: false, ci: 'pass', approved: false, base, attentionIds: [], ...extra,
    });
    storage.set('github-spaces.prs', {
      [`${repo}|stack/1`]: pr('stack/1', 'main'),
      [`${repo}|stack/2`]: pr('stack/2', 'stack/1'),
      [`${repo}|fix`]: pr('fix', 'main'),
    });

    let rows = view.ordered();
    const depthOf = rows.filter(r => !r.tree), by = (id) => rows.find(r => r.w.id === id);    assert.deepEqual([...rows.map(r => [r.w.id, r.depth])], [['main', 0], ['a', 1], ['b', 2], ['c', 1]],
      'a worktree nests under the worktree its PR targets, depth-first');
    console.log('PASS stack depth follows the PR base branch');

    // The sidebar hands github-spaces the checkouts it knows, spaces included.
    view.publish();
    const published = storage.get('spaces.git');
    assert.deepEqual(JSON.parse(JSON.stringify(published[JSON.stringify([null, '/repo-1'])].spaces)), [{ id: 'a', name: 'stack/1' }]);
    assert.equal(published[JSON.stringify([null, '/repo'])].branch, 'main');
    console.log('PASS checkouts are published for the info mod');

    // A base with no space here leaves the worktree a direct child of main.
    storage.set('github-spaces.prs', {
      [`${repo}|stack/2`]: pr('stack/2', 'gone/branch'),
    });
    rows = view.ordered();
    assert.deepEqual([...rows.map(r => [r.w.id, r.depth])], [['main', 0], ['a', 1], ['b', 1], ['c', 1]],
      'an unknown base falls back to the main checkout');
    console.log('PASS unknown base stays under the main checkout');

    // A cycle (two PRs retargeted at each other) still renders each row once.
    storage.set('github-spaces.prs', {
      [`${repo}|stack/1`]: pr('stack/1', 'stack/2'),
      [`${repo}|stack/2`]: pr('stack/2', 'stack/1'),
    });
    rows = view.ordered();
    assert.equal(rows.length, 4, 'no row is drawn twice');
    assert.equal(new Set(rows.map(r => r.w.id)).size, 4, 'every space appears once');
    assert.equal(by('main').depth, 0);
    console.log('PASS a retargeted cycle cannot loop the tree');

    // No main checkout in the list: the stack keeps its own depths.
    spaces = [{ id: 'a', name: 'stack/1', folder: '/repo-1' }, { id: 'b', name: 'stack/2', folder: '/repo-2' }];
    view.shown = new Set(spaces.map(s => s.id));
    storage.set('github-spaces.prs', { [`${repo}|stack/2`]: pr('stack/2', 'stack/1') });
    rows = view.ordered();
    assert.deepEqual([...rows.map(r => [r.w.id, r.depth])], [['a', 0], ['b', 1]],
      'without a main checkout the deepest known parent roots the tree');
    console.log('PASS a missing main checkout does not flatten a stack');

    // --- marks come from the info mod, counts subtract dismissed cards ---
    let mark = view.prMark({ number: 5, state: 'OPEN', conflict: false, ci: 'fail', approved: false, attentionIds: ['x', 'y'] }, t, 'a');
    assert.ok(mark.items[0].kind.endsWith('/x.svg'), 'failed checks draw the cross');
    assert.equal(mark.items[0].text_color, '#ef4444');
    assert.equal(mark.items[2].items[1].items[0], '2', 'the bubble counts attention');
    storage.set('github-spaces.comments', { a: { dismissedIds: ['x'] } });
    mark = view.prMark({ number: 5, state: 'OPEN', conflict: false, ci: 'fail', approved: true, attentionIds: ['x', 'y'] }, t, 'a');
    const bubble = mark.items.find(i => typeof i.tooltip === 'string' && i.tooltip.includes('need attention'));
    assert.equal(bubble.items[1].items[0], '1', 'a dismissed card lowers the visible count');
    assert.ok(mark.items.some(i => i.items?.some(c => String(c.kind).endsWith('/approved.svg'))), 'an approval shows its shield');
    const conflictMark = view.prMark({ number: 6, state: 'OPEN', conflict: true, ci: 'pass', attentionIds: [] }, t, 'a');
    assert.ok(conflictMark.items[0].kind.endsWith('/conflict.svg'), 'conflicts beat passing checks');
    const mergedMark = view.prMark({ number: 7, state: 'MERGED', conflict: true, ci: 'pass', attentionIds: [] }, t, 'a');
    assert.ok(mergedMark.items[0].kind.endsWith('/circle-check.svg'), 'merged beats conflict');
    console.log('PASS marks render from published PR data');

    // A worktree named by task rather than by branch still shows its branch.
    const tail = view.gitTail({ name: 'repo', branch: 'chore/daily-report', ahead: 1, behind: 0, linked: true }, 1, 'daily proxy usage reporter', t, { id: 'x' });
    assert.ok(tail.items.some(i => i.items?.[0] === 'chore/daily-report'), 'a worktree named differently shows its branch');
    const quiet = view.gitTail({ name: 'repo', branch: 'debug-bustem', ahead: 0, behind: 0, linked: true }, 1, 'debug-bustem', t, { id: 'y' });
    assert.ok(!quiet.items.some(i => i.items?.[0] === 'debug-bustem'), 'a worktree named after its branch repeats nothing');
    console.log('PASS worktree rows show a branch only when the name differs');

    // --- git state and the fetch arrow (the viewer owns git; no gh here) ---
    view.watch = () => {};
    const key = JSON.stringify([null, cwd]);
    async function verify(name, ahead, behind, red) {
      await view.check(key, {});
      const g = view.git[key];
      assert.ok(g, `${name}: git state loaded`);
      assert.deepEqual([g.ahead, g.behind], [ahead, behind], name);
      const button = view.fetchButton({ id: 'main' }, g, { ansi4: 'blue' });
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
    assert.ok(moves.every(([name]) => name === 'space.move'), 'only ordering moves are issued');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
