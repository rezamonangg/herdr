const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Record native builder output without needing a running Herdr window.
function element(kind) {
  const node = { kind, items: [], events: {} };
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
        } else if (key.startsWith('on_')) target.events[key] = args[args.length - 1];
        else if (args.length === 1 && typeof args[0] !== 'function') target[key] = args[0];
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
    const saved = new Map();
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
      localStorage: { setItem: (k, v) => saved.set(k, String(v)), getItem: (k) => saved.get(k) ?? null },
    }, { timeout: 1000 });
    const view = new Spaces();
    view.git = {}; view.checked = {}; view.unsure = new Set(); view.pending = new Set();
    view.busy = {}; view.ready = {}; view.at = {}; view.born = {}; view.machines = [];
    view.folded = new Set(); view.reconnecting = {}; view.rebasing = {}; view.foldedSpaces = new Set();
    view.colorsView = {}; view.prsView = {}; view.cardsView = {};
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
    const by = (id) => rows.find(r => r.w.id === id);
    assert.deepEqual([...rows.map(r => [r.w.id, r.depth])], [['main', 0], ['a', 1], ['b', 2], ['c', 1]],
      'a worktree nests under the worktree its PR targets, depth-first');
    assert.deepEqual([...rows.filter(r => r.root).map(r => r.w.id)], ['main'], 'one repo, one refresh control');
    console.log('PASS stack depth follows the PR base branch');

    // --- a parent row folds its subtree; the order and the rail keep every row ---
    assert.deepEqual([...rows.map(r => [r.w.id, r.kids])],
      [['main', true], ['a', true], ['b', false], ['c', false]],
      'a row has children when the next row in depth-first order is deeper');
    view.foldedSpaces = new Set(['a']);
    assert.deepEqual([...view.opened(rows).map(r => r.w.id)], ['main', 'a', 'c'],
      'a folded row keeps its line and hides its subtree');
    view.foldedSpaces = new Set(['main']);
    assert.deepEqual([...view.opened(rows).map(r => r.w.id)], ['main'], 'folding the root hides the repo tree');
    view.foldedSpaces = new Set(['main', 'a']);
    view.foldedSpaces.delete('main');
    assert.deepEqual([...view.opened(rows).map(r => r.w.id)], ['main', 'a', 'c'], 'unfolding a parent keeps a nested fold');
    view.foldedSpaces = new Set();
    const parentRow = view.row(by('main'), t);
    const leafRow = view.row(by('b'), t);
    const chevron = (row) => row.items[0].items.find(c => c.id === 'fold-main');
    assert.ok(chevron(parentRow), 'a parent row carries the fold chevron');
    assert.ok(!leafRow.items[0].items.some(c => c.id?.startsWith?.('fold-')), 'a leaf row has none');
    const before = moves.length;
    chevron(parentRow).events.on_click({}, { stop_propagation() {}, notify() {} });
    assert.deepEqual([...view.foldedSpaces], ['main'], 'the chevron folds the subtree');
    assert.equal(saved.get('spaces-stacks.folded'), '["main"]', 'the fold is remembered');
    assert.deepEqual([...moves.slice(before)], [], 'folding neither selects nor moves a space');
    // The row itself does both: select it and fold its subtree.
    view.foldedSpaces = new Set();
    view.pressed = 'main'; view.over = 'main';
    const clickCx = { stop_propagation() {}, notify() {} };
    const rowMark = moves.length;
    view.row(by('main'), t).events.on_mouse_up({}, clickCx);
    assert.deepEqual([...view.foldedSpaces], ['main'], 'a click on the parent row folds the subtree');
    assert.deepEqual([...moves.slice(rowMark).map(([name]) => name)], ['space.select'], 'and it still selects the space');
    view.pressed = 'b'; view.over = 'b';
    const leafMark = moves.length;
    view.row(by('b'), t).events.on_mouse_up({}, clickCx);
    assert.deepEqual([...view.foldedSpaces], ['main'], 'a leaf click leaves folds alone');
    assert.deepEqual([...moves.slice(leafMark).map(([name]) => name)], ['space.select'], 'a leaf click still selects');
    view.foldedSpaces = new Set();
    view.loadFolds();
    assert.deepEqual([...view.foldedSpaces], ['main'], 'folds come back after a reload');
    view.foldedSpaces = new Set(['a', 'gone']);
    view.pruneFolds();
    assert.deepEqual([...view.foldedSpaces], ['a'], 'a fold for a space that is gone is forgotten');
    view.foldedSpaces = new Set(['a']);
    spaces.find(s => s.id === 'b').active = true;
    view.grouped(t, false);
    assert.equal(view.activeAt, -1, 'an active space inside a folded subtree is not drawn or scrolled to');
    view.foldedSpaces = new Set();
    view.grouped(t, false);
    assert.equal(view.activeAt, 2, 'unfolding draws it again');
    delete spaces.find(s => s.id === 'b').active;
    console.log('PASS a stack folds from its parent row and is remembered');
    moves.length = 0; // the fold clicks above selected spaces; below is about ordering moves


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

    // Two spaces on the repo's own checkout stay siblings: only linked
    // worktrees belong under it.
    spaces = [{ id: 'm1', name: 'repo', folder: '/repo' }, { id: 'm2', name: 'repo two', folder: '/repo/src' }];
    view.shown = new Set(spaces.map(s => s.id));
    storage.set('github-spaces.prs', {});
    view.git = {
      [JSON.stringify([null, '/repo'])]: { name: 'repo', branch: 'main', ahead: 0, behind: 0, repo, linked: false },
      [JSON.stringify([null, '/repo/src'])]: { name: 'repo', branch: 'main', ahead: 0, behind: 0, repo, linked: false },
    };
    rows = view.ordered();
    assert.deepEqual([...rows.map(r => [r.w.id, r.depth])], [['m1', 0], ['m2', 0]],
      'a second space on the same checkout is a sibling, not a child');
    console.log('PASS two spaces on one checkout stay siblings');

    // A detached checkout has no branch to ask GitHub about.
    view.published = null;
    view.git = { [JSON.stringify([null, '/repo'])]: { name: 'repo', branch: '(detached)', ahead: 0, behind: 0, repo, linked: false } };
    view.publish();
    assert.equal(storage.get('spaces.git')[JSON.stringify([null, '/repo'])], undefined, 'detached checkouts are not published');
    console.log('PASS detached checkouts are not published');

    // A space that is not a repo still renders, with no repo controls.
    spaces = [{ id: 'plain', name: 'scratch', folder: '/tmp/scratch' }];
    view.shown = new Set(['plain']);
    view.git = {};
    rows = view.ordered();
    assert.equal(rows.length, 1, 'a non-repo space is drawn');
    assert.equal(rows[0].root, false, 'and is nobody\'s refresh control');
    console.log('PASS non-repo spaces render without repo controls');

    // --- marks come from the info mod, counts subtract dismissed cards ---
    view.cardsView = null; view.prsView = null;
    let mark = view.prMark({ number: 5, state: 'OPEN', conflict: false, ci: 'fail', approved: false, attentionIds: ['x', 'y'] }, t, 'a');
    assert.ok(mark.items[0].kind.endsWith('/x.svg'), 'failed checks draw the cross');
    assert.equal(mark.items[0].text_color, '#ef4444');
    assert.equal(mark.items[2].items[1].items[0], '2', 'the bubble counts attention');
    storage.set('github-spaces.comments', { a: { dismissedIds: ['x'] } });
    view.cardsView = null;
    mark = view.prMark({ number: 5, state: 'OPEN', conflict: false, ci: 'fail', approved: true, attentionIds: ['x', 'y'] }, t, 'a');
    const bubble = mark.items.find(i => typeof i.tooltip === 'string' && i.tooltip.includes('need attention'));
    assert.equal(bubble.items[1].items[0], '1', 'a dismissed card lowers the visible count');
    assert.ok(mark.items.some(i => i.items?.some(c => String(c.kind).endsWith('/approved.svg'))), 'an approval shows its shield');
    storage.set('github-spaces.comments', {}); view.cardsView = null;
    const historyMark = view.prMark({ number: 9, state: 'OPEN', conflict: false, ci: 'pass', attentionIds: [], commentsTotal: 3 }, t, 'a');
    const history = historyMark.items.find(i => typeof i.tooltip === 'string' && i.tooltip.includes('none pending'));
    assert.equal(history.items[1].items[0], '3', 'comments with nothing pending still show a dim count');
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
