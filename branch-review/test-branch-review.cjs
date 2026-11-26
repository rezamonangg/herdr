const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'mods/branch-review/main.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/export default class /, 'class ').replace(/^export /gm, '');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-test-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const exec = (cmd, args, options = {}) => {
    const r = spawnSync(cmd, args, { cwd: options.cwd || repo, encoding: 'utf8' });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const storage = new Map();
  let where = repo;
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Mod test');
    git('config', 'user.email', 'mod-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/keep.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'old.txt'), 'rename me\n');
    fs.writeFileSync(path.join(repo, 'drop.txt'), 'gone\n');
    git('add', '.'); git('commit', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const base1 = git('rev-parse', 'HEAD');

    fs.writeFileSync(path.join(repo, 'main-only.txt'), 'main line\n');
    git('add', '.'); git('commit', '-m', 'main only');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const base2 = git('rev-parse', 'HEAD');

    git('checkout', '-qb', 'release', base1);
    fs.writeFileSync(path.join(repo, 'release.txt'), 'release\n');
    git('add', '.'); git('commit', '-m', 'release');
    git('checkout', '-q', 'main');

    git('checkout', '-qb', 'feature', base2);
    fs.writeFileSync(path.join(repo, 'src/keep.txt'), 'one\nTWO\nthree\n');
    fs.writeFileSync(path.join(repo, 'src/feature.txt'), 'new\n');
    fs.rmSync(path.join(repo, 'main-only.txt'));
    fs.rmSync(path.join(repo, 'drop.txt'));
    git('mv', 'old.txt', 'new name.txt');
    git('add', '-A'); git('commit', '-m', 'feature');
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked\n');
    fs.writeFileSync(path.join(repo, 'src/keep.txt'), 'one\nTWO\nthree\nuncommitted\n');

    const cx = {
      focus_handle: () => ({ focus() {}, is_focused: () => false }),
      spawn: (fn) => fn(cx), notify() {}, sleep: async () => {},
    };
    const view = vm.runInNewContext(`${source}\n({ BranchReview, parseNameStatus, parseNumstat, parseUnified, splitRows, treeRows, fileEntries, rankRefs })`, {
      View: class {},
      div: () => ({ when() { return this; } }), h_flex: () => ({ when() { return this; } }), v_flex: () => ({ when() { return this; } }),
      Scrollbar: { vertical: () => ({}) }, v_virtual_list: () => ({}),
      checking: () => true, exec, appHome: () => dir, readTextFile: async (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
      settings: () => ({ font_size: 13, font_family: 'mono' }), theme: () => ({ background: '#111111' }),
      focused: () => ({ tab: 't1', pane: null, cwd: where, space: 's1' }),
      panes: () => [],
      spaces: () => [{ id: 's1', active: true, folder: where, machine: null, tabs: [{ id: 't1', active: true }] }],
      props: () => ({}), shared: (k) => storage.get(k), setShared: (k, v) => storage.set(k, v),
      colorRows: (rows) => { for (const row of rows) if (row.m !== undefined) row.code = [[row.m, null]]; return rows.length; },
      languageFor: () => null,
      run: () => null,
    }, { timeout: 3000 });

    assert.deepEqual(
      JSON.parse(JSON.stringify(view.parseNameStatus('R100\0old.txt\0new name.txt\0M\0a\0D\0b\0'))),
      [{ path: 'new name.txt', orig: 'old.txt', letter: 'R' }, { path: 'a', orig: null, letter: 'M' }, { path: 'b', orig: null, letter: 'D' }]
    );
    const stats = view.parseNumstat('0\t0\t\0old.txt\0new name.txt\0-\t-\tbin\0');
    assert.deepEqual(JSON.parse(JSON.stringify([...stats])), [['new name.txt', { add: 0, del: 0 }], ['bin', { add: null, del: null }]]);
    assert.deepEqual(JSON.parse(JSON.stringify(view.rankRefs(['feature', 'origin/release', 'origin/main', 'origin/HEAD', 'main'], 'feature', 'origin/main'))),
      ['origin/main', 'main', 'origin/release']);
    console.log('PASS git formats and base ordering');

    const rows = [
      { k: 'fold', text: '⋯' },
      { k: 'del', o: 1, n: null, m: 'old' },
      { k: 'add', o: null, n: 1, m: 'new' },
      { k: 'ctx', o: 2, n: 2, m: 'same' },
      { k: 'del', o: 3, n: null, m: 'gone' },
    ];
    const split = view.splitRows(rows);
    assert.equal(split[0].k, 'fold');
    assert.equal(split[1].k, 'pair');
    assert.equal(split[1].d.m, 'old');
    assert.equal(split[1].a.m, 'new');
    assert.equal(split[2].k, 'ctx');
    assert.equal(split[3].k, 'pair');
    assert.equal(split[3].a, null, 'an unpaired deletion has a blank right side');
    console.log('PASS split pairing');

    const tree = view.treeRows([{ path: 'src/a.txt' }, { path: 'src/deep/b.txt' }, { path: 'root.txt' }]);
    assert.deepEqual(JSON.parse(JSON.stringify(tree.map((r) => [r.k, r.depth, r.k === 'dir' ? r.name : r.file.path]))),
      [['dir', 0, 'src'], ['dir', 1, 'deep'], ['file', 2, 'src/deep/b.txt'], ['file', 1, 'src/a.txt'], ['file', 0, 'root.txt']]);
    console.log('PASS file tree');

    const review = new view.BranchReview();
    review.init({}, cx);
    await review.load(cx);
    assert.equal(review.error, null);
    assert.equal(review.base, 'origin/main');
    assert.ok(review.files.some((f) => f.path === 'src/feature.txt'));
    assert.ok(review.files.some((f) => f.path === 'scratch.txt' && f.kind === 'untracked'), 'untracked files are listed');
    assert.ok(review.files.some((f) => f.path === 'new name.txt' && f.kind === 'renamed'), 'renames keep both paths');
    assert.ok(review.rows.some((r) => r.k === 'del' || r.k === 'add'), 'the fallback plain diff has rows');
    assert.equal(review.where.base.merge_base, git('merge-base', 'origin/main', 'HEAD'));
    console.log('PASS load: files, untracked, rename, plain fallback diff');

    await review.pick(cx, review.files.find((f) => f.path === 'src/feature.txt'));
    assert.equal(review.oneSided, 'new', 'an added file is shown as one side');
    await review.pick(cx, review.files.find((f) => f.path === 'drop.txt'));
    assert.equal(review.oneSided, 'old', 'a deleted file is shown as one side');
    await review.pick(cx, review.files.find((f) => f.path === 'scratch.txt'));
    assert.equal(review.oneSided, 'new', 'an untracked file is one-sided');
    assert.equal(review.rows.map((r) => r.m).join('\n'), 'untracked', 'untracked content is read directly');
    await review.pick(cx, review.files.find((f) => f.path === 'src/keep.txt'));
    assert.equal(review.oneSided, null, 'a file with both sides uses the split view');

    await review.choose(cx, 'release');
    assert.ok(!review.files.some((f) => f.path === 'main-only.txt'), 'the base changes the file list');
    assert.equal(review.where.base.merge_base, git('merge-base', 'release', 'HEAD'));
    assert.equal(storage.get('branch-review.base')[`:${git('rev-parse', '--show-toplevel')}`], 'release');
    console.log('PASS base switch');

    await review.choose(cx, 'no-such-branch');
    assert.match(review.flash, /not found/);
    assert.equal(review.base, 'origin/main');
    console.log('PASS missing base is reported');

    // A folder that is not a repo settles on a message instead of reloading on
    // every frame: the asked key is remembered.
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    where = plain;
    review.wantKey = null;
    await review.load(cx);
    assert.match(review.error, /Not a git repository/);
    assert.equal(review.loading, false, 'it stops loading');
    assert.equal(review.wantKey, JSON.stringify([plain, null, 't1']), 'the asked key is stored, so render does not kick again');
    console.log('PASS a non-git folder settles instead of reloading');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
