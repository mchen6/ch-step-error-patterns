'use strict';
// A parallel runner's tag before a test runner's own mark ("[a.test.js] ",
// "web-1  | ", "pkg:test: "), and Rust's panic line with a thread id: read as
// the runner meant them.
const test = require('node:test');
const assert = require('node:assert');
const {extractErrors, RULES} = require('../lib/patterns');

const EXIT = '##[error]Process completed with exit code 1.';
const kinds = (line) => extractErrors([{name: 'Run x', lines: [line, 'a', 'b', 'c', 'd', 'e', 'f', EXIT]}], 40).lines
  .filter((l) => l.index === 0 && l.kind !== 'tail').map((l) => l.kind);
const SKIP = '\ufe63';

test('a passing or skipped test under a tag is no error, whatever its title says', () => {
  for (const line of [
    '[a.test.js] ✔ a rename that fails is not fatal: lines go on (4.2ms)',
    '[a.test.js] ✓ retries after a TypeError',
    `[a.test.js] ${SKIP} the runner: a file past its time is FAILED as timed out (0.1ms)`,
    'web-1  | ✔ survives a fatal: error',
    '@acme/core:test: ✔ survives a fatal: error',
    '[0] ok 3 - no Error here'
  ]) assert.deepStrictEqual(kinds(line), [], line);
});

test('a skipped test with no tag is no error either', () => {
  assert.deepStrictEqual(kinds(`${SKIP} the runner: a file past its time is FAILED as timed out (0.1ms)`), []);
});

test('a failing test under a tag is an error, as it is with none', () => {
  for (const line of ['[a.test.js] ✖ the plugin route (9.4ms)', 'web-1  | ✖ the plugin route', '@acme/core:test: ● suite › compares', '[1] not ok 4 - compares']) {
    assert.deepStrictEqual(kinds(line), ['error'], line);
  }
});

test('a tag on anything else changes nothing', () => {
  assert.deepStrictEqual(kinds('[ERROR] Failed to execute goal'), ['error']);
  assert.deepStrictEqual(kinds('[a.test.js]   TypeError: x is not a function'), ['error']);
  assert.deepStrictEqual(kinds('[a.test.js]   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:'), ['assert']);
  assert.deepStrictEqual(kinds('[a.test.js] nothing to see'), []);
});

test('a Rust panic with a thread id is a panic: its message is kept beside it', () => {
  for (const head of ["thread 'r_eq' (815558) panicked at src/lib.rs:1:20:", "thread 'r_eq' panicked at src/lib.rs:1:20:"]) {
    const lines = ['---- r_eq stdout ----', '', head, 'assertion `left == right` failed', '  left: "one"', ' right: "two"', 'note: run with `RUST_BACKTRACE=1`', '', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', EXIT];
    const out = extractErrors([{name: 'Run cargo test', lines}], 40).lines.filter((l) => l.kind !== 'tail');
    assert.deepStrictEqual(out.filter((l) => l.index >= 2 && l.index <= 5).map((l) => l.kind), ['error', 'assert', 'assert', 'assert'], head);
  }
});

test('these rules are version 4: a signature made under 3 is read again', () => {
  assert.strictEqual(RULES, 4);
});
