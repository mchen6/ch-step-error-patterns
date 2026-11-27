'use strict';
// Two lines a failure prints after its verdict, no longer lost:
// (a) a FAIL naming a file and line (`FAIL docs/x.md:339`): the lines
//     indented under it, at most three, until a blank line, a line indented
//     no deeper, or another verdict, kept as error lines (its message);
// (b) node's assertion (`AssertionError [ERR_ASSERTION]`): when the last line
//     before its first stack frame (within 60 lines) is its comparison
//     (`1 !== 0`, `'a' != 'b'`, at most 200 characters) and a long message
//     ended the block before it, that line is one of the block's values all
//     the same: screened as values are, never in `lines`, so never in the
//     failure signature.
// No other format gains a line.
const test = require('node:test');
const assert = require('node:assert');
const {extractErrors} = require('../lib/patterns');

const run = (lines, max = 40) => extractErrors([{name: 'Run tests', lines: [...lines, '##[error]Process completed with exit code 1.']}], max);
const valuesOf = (out) => (out.details == null ? [] : out.details.blocks.flatMap((b) => b.values));
const kept = (lines, max = 40) => extractErrors([{name: 'Run tests', lines: [...lines, '##[error]Process completed with exit code 1.']}], max).lines
  .filter((l) => l.kind !== 'exit' && l.kind !== 'tail').map((l) => [l.text, l.kind]);

test('(a) a FAIL naming a file and line keeps the lines indented under it', () => {
  assert.deepStrictEqual(kept(['FAIL Article/PythonBasis/python13/2.md:339', '  timeout after 30s', '', 'FAIL Article/PythonBasis/python2/Type_of_data.md:442', '  File "/tmp/tmpjg271vyh.py", line 4', '    print(f\'{data[\'name\']}\')', '']), [
    ['FAIL Article/PythonBasis/python13/2.md:339', 'error'],
    ['  timeout after 30s', 'error'],
    ['FAIL Article/PythonBasis/python2/Type_of_data.md:442', 'error'],
    ['  File "/tmp/tmpjg271vyh.py", line 4', 'stack'],
    ['    print(f\'{data[\'name\']}\')', 'error']
  ]);
});

test('(a) the message starts no value block', () => {
  assert.ok(run(['FAIL src/a.md:1', '  one', '  two', '  three', '  four']).details == null);
});

test('(a) at most three, stopping at a blank line, a line no deeper, or another verdict', () => {
  assert.deepStrictEqual(kept(['FAIL src/a.md:1', '  one', '  two', '  three', '  four']).map(([t]) => t), ['FAIL src/a.md:1', '  one', '  two', '  three']);
  assert.deepStrictEqual(kept(['FAIL src/a.md:1', '  one', 'not under it']).map(([t]) => t), ['FAIL src/a.md:1', '  one']);
  assert.deepStrictEqual(kept(['FAIL src/a.md:1', '', '  after a blank']).map(([t]) => t), ['FAIL src/a.md:1']);
  assert.deepStrictEqual(kept(['  FAIL src/a.md:1', '  same depth']).map(([t]) => t), ['  FAIL src/a.md:1']);
});

test('(b) node\'s comparison, past a long message, is one of the assertion\'s values, never an error line', () => {
  const message = Array.from({length: 40}, (_, i) => `  diagnosis line ${i}: the daemon was running`);
  const lines = ['✖ the shared runtime through the native shim (44394.95ms)', '  AssertionError [ERR_ASSERTION]: FAIL (b-latched) a loosening is refused as the latch', '      {"jsonrpc":"2.0","id":2,"result":{"isError":true}}', ...message, '', '  1 !== 0', '', '      at TestContext.<anonymous> (/home/runner/work/x/test/acceptance.test.js:452:10)'];
  const out = run(lines);
  assert.ok(valuesOf(out).includes('  1 !== 0'), JSON.stringify(out.details));
  // (the failing step's tail may hold it, as any line, when few lines matched)
  assert.ok(!out.lines.some((l) => l.text === '  1 !== 0' && l.kind !== 'tail'), 'not among the error lines, so not in the signature');
  // != for a loose equal, the same way
  const loose = run(['  AssertionError [ERR_ASSERTION]: \'a\' != \'b\'', ...message, '  \'a\' != \'b\'', '      at Object.<anonymous> (/w/test/b.js:3:8)']);
  assert.ok(valuesOf(loose).includes('  \'a\' != \'b\''), JSON.stringify(loose.details));
});

test('(b) node\'s own generated form, where the block reaches the comparison, is as before', () => {
  const near = ['  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '', '  1 !== 2', '', '      at TestContext.<anonymous> (/w/test/a.test.js:7:10)'];
  const out = run(near);
  assert.strictEqual(valuesOf(out).filter((v) => v === '  1 !== 2').length, 1, JSON.stringify(out.details));
  assert.ok(!out.lines.some((l) => l.text === '  1 !== 2' && l.kind !== 'tail'));
});

test('(b) nothing is added past 60 lines, without the comparison\'s shape, over 200 characters, or for another runner\'s AssertionError', () => {
  const far = Array.from({length: 61}, (_, i) => `  line ${i}`);
  assert.ok(!valuesOf(run(['  AssertionError [ERR_ASSERTION]: long', ...far, '  1 !== 0', '      at T (/w/t.js:1:1)'])).includes('  1 !== 0'));
  assert.ok(!valuesOf(run(['  AssertionError [ERR_ASSERTION]: short', ...far.slice(0, 20), '  the end of the message', '      at T (/w/t.js:1:1)'])).includes('  the end of the message'));
  const long = `  ${'a'.repeat(200)} !== 0`;
  assert.ok(!valuesOf(run(['  AssertionError [ERR_ASSERTION]: x', ...far.slice(0, 20), long, '      at T (/w/t.js:1:1)'])).some((v) => v.endsWith('!== 0')));
  // (Python's AssertionError, then another traceback whose source line holds !=)
  const py = run(['AssertionError: not equal', ...far.slice(0, 20), 'Traceback (most recent call last):', '    if a != b:', '  File "/w/t.py", line 3, in test_x']);
  assert.ok(!valuesOf(py).includes('    if a != b:'), JSON.stringify(py.details));
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
