'use strict';
// The lines that reach `lines` pass the same screen as `details` (lib/values.js):
// a value that doesn't read as words, a number or a name is withheld there too,
// so a fixture token a test compared doesn't reach the model through a verdict,
// a Rust panic's left:/right:, or the failing step's tail. Readable lines are
// unchanged. Every value here is made at run time: random letters and digits,
// no known secret's shape, never a literal in this file.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {extractErrors, RULES} = require('../lib/patterns');
const {WITHHELD, LINE_WITHHELD} = require('../lib/values');

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
// (26 characters, letters and digits mixed, drawn at random each run)
const value = () => {
  for (;;) {
    const v = [...crypto.randomBytes(26)].map((b) => ALNUM[b % ALNUM.length]).join('');
    if (/[0-9]/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v)) return v;
  }
};
const run = (lines) => extractErrors([{name: 'test', lines}], 40, null);
const textOf = (out, re) => out.lines.find((l) => re.test(l.text));

test('a Rust panic\'s left: and right: values are withheld in lines', () => {
  const v = value();
  const w = value();
  const out = run([
    'running 1 test',
    "thread 'tests::reads_value' panicked at src/lib.rs:10:5:",
    'assertion `left == right` failed',
    `  left: "${v}"`,
    ` right: "${w}"`,
    'test tests::reads_value ... FAILED',
    'error: test failed, to rerun pass --lib'
  ]);
  const all = out.lines.map((l) => l.text).join('\n');
  assert.ok(!all.includes(v) && !all.includes(w), all);
  assert.match(textOf(out, /left:/).text, new RegExp(`left: "${WITHHELD}"`));
  assert.match(textOf(out, /right:/).text, new RegExp(`right: "${WITHHELD}"`));
});

test('a Node assertion verdict carrying the compared value has it withheld in lines', () => {
  const v = value();
  const out = run([
    '# Subtest: reads the token',
    `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + actual - expected + '${v}' - 'ok'`,
    '    at TestContext.<anonymous> (/repo/test/a.test.js:5:10)',
    'not ok 1 - reads the token'
  ]);
  const verdict = textOf(out, /AssertionError/);
  assert.ok(verdict != null, JSON.stringify(out.lines));
  assert.ok(!verdict.text.includes(v), verdict.text);
  assert.ok(verdict.text.includes(WITHHELD), verdict.text);
});

test('a value in the failing step\'s tail is withheld in lines', () => {
  const v = value();
  const out = run([
    'npm ERR! code ELIFECYCLE',
    `Error: request rejected for session ${v}`,
    'npm ERR! Test failed.  See above for more details.'
  ]);
  const all = out.lines.map((l) => l.text).join('\n');
  assert.ok(out.lines.length > 0, 'the tail is kept');
  assert.ok(!all.includes(v), all);
});

test('readable lines are unchanged: words, paths with line numbers, a test name, a plain number', () => {
  const lines = [
    "thread 'tests::reads_value' panicked at src/lib.rs:10:5:",
    'assertion `left == right` failed',
    '  left: 3',
    ' right: 4',
    'test tests::reads_value ... FAILED',
    'error: test failed, to rerun pass --lib'
  ];
  const out = run(['running 1 test', ...lines]);
  const kept = out.lines.map((l) => l.text);
  for (const t of kept) assert.ok(lines.includes(t), `changed: ${t}`);
  assert.ok(!kept.some((t) => t.includes(WITHHELD) || t === LINE_WITHHELD), kept.join('\n'));
});

// (the failure signature is made from these lines: a cache keyed on the rules
// is rebuilt)
test('the rules name this version: 6', () => {
  assert.strictEqual(RULES, 6);
  assert.strictEqual(run(['Error: boom']).rules, 6);
});
