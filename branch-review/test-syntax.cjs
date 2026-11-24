const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, 'mods/branch-review');
const prism = fs.readFileSync(path.join(dir, 'vendor/prism.js'), 'utf8').replace(/^export default Prism;$/m, '');
const syntax = fs.readFileSync(path.join(dir, 'syntax.js'), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace(/^export /gm, '')
  .replace(/^export \{ LIMIT \};$/m, '');

const { tokenizeSide, colorRows, languageFor, untab } = vm.runInNewContext(
  `${prism}\n${syntax}\n({ tokenizeSide, colorRows, languageFor, untab })`,
  { console },
  { timeout: 5000 }
);

// Whole-file input keeps a block comment coloured across lines.
const go = '/* one\ntwo */\npackage main\nfunc main() { s := "x" }';
const lines = tokenizeSide(go, 'go');
assert.equal(lines[0][0][1], 'com');
assert.equal(lines[1][0][1], 'com');
assert.equal(lines[2][0][1], 'kw');
assert.ok(lines[3].some(([, role]) => role === 'str'));
assert.equal(lines.map((spans) => spans.map(([t]) => t).join('')).join('\n'), go);
console.log('PASS whole-file comment state and text preservation');

const rows = [
  { k: 'add', n: 1, m: 'package main' },
  { k: 'ctx', n: 2, m: '// hi' },
  { k: 'del', o: 1, m: 'old' },
];
const coloured = colorRows(rows, {
  oldText: 'old\n', newText: 'package main\n// hi\n', oldLang: 'go', newLang: 'go',
});
assert.equal(coloured, 3);
assert.equal(rows[0].code.map(([t]) => t).join(''), rows[0].m);
assert.equal(rows[0].code[0][1], 'kw');
assert.equal(rows[1].code[0][1], 'com');
assert.equal(rows[2].code[0][1], 'text');
console.log('PASS rows take colours from the matching side');

const plain = [{ k: 'add', n: 1, m: 'package main' }];
colorRows(plain, { newText: 'something else\n', newLang: 'go' });
assert.deepEqual(JSON.parse(JSON.stringify(plain[0].code)), [['package main', null]], 'a mismatch stays plain');
console.log('PASS mismatched text stays plain');

assert.equal(languageFor('a/b.go'), 'go');
assert.equal(languageFor('x.yaml'), 'yaml');
assert.equal(languageFor('README'), null);
assert.equal(untab('a\tb'), 'a   b');
console.log('PASS language mapping and tab expansion');
