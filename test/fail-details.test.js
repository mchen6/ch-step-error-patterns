'use strict';
// Two lines a failure prints after its verdict, kept among the error lines:
// (a) a FAIL naming a file and line (`FAIL docs/x.md:339`): the lines
//     indented under it, at most three, until a blank line, a line indented
//     no deeper, or another verdict -- as a failed go test's details are;
// (b) node's assertion: when the last line before the first stack frame
//     (within 60 lines of the AssertionError) is its comparison
//     (`1 !== 0`, `'a' != 'b'`), that line, which a long message pushes past
//     the values a block can hold.
// Kept as assert lines, ranked with their verdict, within max_lines; no
// other format gains a line.
const test = require('node:test');
const assert = require('node:assert');
const {extractErrors} = require('../lib/patterns');

const kept = (lines, max = 40) => extractErrors([{name: 'Run tests', lines: [...lines, '##[error]Process completed with exit code 1.']}], max).lines
  .filter((l) => l.kind !== 'exit' && l.kind !== 'tail').map((l) => [l.text, l.kind]);

test('(a) a FAIL naming a file and line keeps the lines indented under it', () => {
  assert.deepStrictEqual(kept(['FAIL Article/PythonBasis/python13/2.md:339', '  timeout after 30s', '', 'FAIL Article/PythonBasis/python2/Type_of_data.md:442', '  File "/tmp/tmpjg271vyh.py", line 4', '    print(f\'{data[\'name\']}\')', '']), [
    ['FAIL Article/PythonBasis/python13/2.md:339', 'error'],
    ['  timeout after 30s', 'assert'],
    ['FAIL Article/PythonBasis/python2/Type_of_data.md:442', 'error'],
    ['  File "/tmp/tmpjg271vyh.py", line 4', 'stack'],
    ['    print(f\'{data[\'name\']}\')', 'assert']
  ]);
});

test('(a) at most three, stopping at a blank line, a line no deeper, or another verdict', () => {
  assert.deepStrictEqual(kept(['FAIL src/a.md:1', '  one', '  two', '  three', '  four']).map(([t]) => t), ['FAIL src/a.md:1', '  one', '  two', '  three']);
  assert.deepStrictEqual(kept(['FAIL src/a.md:1', '  one', 'not under it']).map(([t]) => t), ['FAIL src/a.md:1', '  one']);
  assert.deepStrictEqual(kept(['FAIL src/a.md:1', '', '  after a blank']).map(([t]) => t), ['FAIL src/a.md:1']);
  assert.deepStrictEqual(kept(['  FAIL src/a.md:1', '  same depth']).map(([t]) => t), ['  FAIL src/a.md:1']);
});

test('(b) node\'s comparison, the last line before the first frame, is kept with its assertion', () => {
  const message = Array.from({length: 40}, (_, i) => `  diagnosis line ${i}: the daemon was running`);
  assert.deepStrictEqual(kept(['✖ the shared runtime through the native shim (44394.95ms)', '  AssertionError [ERR_ASSERTION]: FAIL (b-latched) a loosening is refused as the latch', ...message, '', '  1 !== 0', '', '      at TestContext.<anonymous> (/home/runner/work/x/test/acceptance.test.js:452:10)']).filter(([, k]) => k === 'assert').map(([t]) => t),
    ['  AssertionError [ERR_ASSERTION]: FAIL (b-latched) a loosening is refused as the latch', '  1 !== 0']);
  // != for a loose equal, as far from its assertion
  const loose = kept(['  AssertionError [ERR_ASSERTION]: \'a\' != \'b\'', ...message, '  \'a\' != \'b\'', '      at Object.<anonymous> (/w/test/b.js:3:8)']);
  assert.ok(loose.some(([t, k]) => t === '  \'a\' != \'b\'' && k === 'assert'), JSON.stringify(loose));
});

test('(b) near its assertion (node\'s own generated form), the comparison is the values\' to show: no line added', () => {
  const near = ['  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '', '  1 !== 2', '', '      at TestContext.<anonymous> (/w/test/a.test.js:7:10)'];
  assert.ok(!kept(near).some(([t]) => t === '  1 !== 2'), JSON.stringify(kept(near)));
  // (twelve lines away is still the values' reach; thirteen is past it)
  const at = (n) => kept(['  AssertionError [ERR_ASSERTION]: x', ...Array.from({length: n - 1}, (_, i) => `  m ${i}`), '  1 !== 0', '      at T (/w/t.js:1:1)']);
  assert.ok(!at(12).some(([t]) => t === '  1 !== 0'), 'at 12');
  assert.ok(at(13).some(([t, k]) => t === '  1 !== 0' && k === 'assert'), 'at 13');
});

test('(b) a frame more than 60 lines away, or no comparison before it, adds nothing', () => {
  const far = Array.from({length: 61}, (_, i) => `  line ${i}`);
  const a = kept(['  AssertionError [ERR_ASSERTION]: long', ...far, '  1 !== 0', '      at T (/w/t.js:1:1)']);
  assert.ok(!a.some(([t]) => t === '  1 !== 0'), JSON.stringify(a));
  const b = kept(['  AssertionError [ERR_ASSERTION]: short', '  the end of the message', '      at T (/w/t.js:1:1)']);
  assert.ok(!b.some(([t]) => t === '  the end of the message'), JSON.stringify(b));
  // (over 200 characters: no comparison shape)
  const c = kept(['  AssertionError [ERR_ASSERTION]: x', `  ${'a'.repeat(200)} !== 0`, '      at T (/w/t.js:1:1)']);
  assert.ok(!c.some(([t]) => t.endsWith('!== 0')), JSON.stringify(c));
});

test('no other format gains a line: jest, pytest, go, Rust, mocha without the shape, plain', () => {
  const before = (lines) => kept(lines);
  const cases = {
    jest: ['FAIL src/api/user.test.ts', '  ✕ adds two numbers (5 ms)', '  ● adds two numbers', '    expect(received).toBe(expected) // Object.is equality', '    Expected: 4', '    Received: 3'],
    pytest: ['FAILED tests/test_a.py::test_a - assert 1 == 2', '    assert 1 == 2', '=== 1 failed in 0.01s ==='],
    go: ['--- FAIL: TestParse (0.00s)', '    parse_test.go:12: got 1, want 2', 'FAIL', 'FAIL\tgithub.com/acme/widgets\t0.012s'],
    rust: ['test tests::adds ... FAILED', 'failures:', '    tests::adds', 'test result: FAILED. 0 passed; 1 failed'],
    mocha: ['  1) adds:', '     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '     + actual - expected', '     -3', '     +4', '      at Context.<anonymous> (test/add.js:5:10)'],
    plain: ['FAIL: the build broke', '  because of a typo', 'Error: something went wrong', '  at the end']
  };
  // (main's own output for each, before these rules: unchanged)
  const expected = {
    jest: [["FAIL src/api/user.test.ts", "error"], ["  ● adds two numbers", "error"], ["    expect(received).toBe(expected) // Object.is equality", "assert"], ["    Expected: 4", "assert"], ["    Received: 3", "assert"]],
    pytest: [["FAILED tests/test_a.py::test_a - assert 1 == 2", "error"]],
    go: [["--- FAIL: TestParse (0.00s)", "error"], ["    parse_test.go:12: got 1, want 2", "assert"], ["FAIL", "error"], ["FAIL\tgithub.com/acme/widgets\t0.012s", "error"]],
    rust: [["test tests::adds ... FAILED", "error"], ["test result: FAILED. 0 passed; 1 failed", "error"]],
    mocha: [["  1) adds:", "error"], ["     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "assert"], ["      at Context.<anonymous> (test/add.js:5:10)", "stack"]],
    plain: [["FAIL: the build broke", "error"], ["Error: something went wrong", "error"], ["  at the end", "stack"]]
  };
  for (const [name, lines] of Object.entries(cases)) assert.deepStrictEqual(before(lines), expected[name], name);
});
