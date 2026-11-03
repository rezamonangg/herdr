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
    const source = fs.readFileSync(path.join(__dirname, 'mods/github-spaces/main.js'), 'utf8')
      .replace(/^import .*;$/gm, '').replace(/export default class /, 'class ').replace(/^export /gm, '');
    const Spaces = vm.runInNewContext(`${source}\nSpaces`, {
      View: class {}, div: () => element('div'), h_flex: () => element('row'),
      svg: (p) => element(p), exec,
    }, { timeout: 1000 });
    const view = new Spaces();
    view.git = {}; view.checked = {}; view.unsure = new Set(); view.rebasing = {};
    view.watch = () => {}; // No filesystem watcher in a one-shot test.
    const key = JSON.stringify([null, cwd]);
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
