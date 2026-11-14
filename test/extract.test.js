'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('./support');
const {extractErrors} = require('../lib/patterns');
const extract = require('../handlers/patternService/extract');
const nodeTest = require('./fixtures/steps-node-test.json');
const python = require('./fixtures/steps-python.json');

const L = (step, index, kind) => ({step, index, kind});
const shape = (out) => out.lines.map(({step, index, kind}) => ({step, index, kind}));

test('finds the failing step and its error lines', () => {
  // ch-step-log-clean's output for its ubuntu fixture: a node --test failure.
  const out = extractErrors(nodeTest.steps, 40);
  assert.strictEqual(out.failingStep, 'Run npm test');
  assert.strictEqual(out.truncated, false);
  const S = 'Run npm test';
  // Four lines match, under five, so the failing step's tail fills in the rest.
  assert.deepStrictEqual(shape(out), [
    L(S, 0, 'tail'), L(S, 1, 'tail'), L(S, 2, 'tail'),
    L(S, 3, 'error'), L(S, 4, 'assert'), L(S, 5, 'tail'), L(S, 6, 'stack'), L(S, 7, 'exit')
  ]);
  assert.strictEqual(out.lines[7].text, '##[error]Process completed with exit code 1.');
  assert.strictEqual(out.lines[4].text, '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:');
});

test('a Python traceback: its head and its two innermost frames, the assertion, the exit; an error in a post step is listed but is not the failing step', () => {
  const out = extractErrors(python.steps, 40);
  assert.strictEqual(out.failingStep, 'Run pytest -q');
  const S = 'Run pytest -q';
  assert.deepStrictEqual(shape(out), [
    L(S, 5, 'stack'), L(S, 8, 'stack'), L(S, 9, 'stack'), L(S, 10, 'assert'), L(S, 11, 'assert'), L(S, 13, 'exit'),
    L('Post job cleanup', 0, 'error')
  ]);
});

test('runner and tool patterns', () => {
  const kinds = (line) => extractErrors([{name: 'Run x', lines: [line]}], 40).lines.filter((l) => l.kind !== 'tail').map((l) => l.kind);
  const cases = [
    ['TypeError: Cannot read properties of undefined', ['error']],
    ['Error: ENOENT: no such file or directory', ['error']],
    ['java.lang.IllegalStateException: closed', ['error']],
    ['npm error code 1', ['error']],
    ['    console.error', []],
    ['PASS tests/error.test.js', []],
    ['  ● adds › two numbers', ['error']],
    ['    expect(received).toBe(expected) // Object.is equality', ['assert']],
    ['    Expected: 4', ['assert']],
    ['    Received: 3', ['assert']],
    ['error[E0308]: mismatched types', ['error']],
    ["  3:5  error  'x' is not defined  no-undef", ['error']],
    ['Found 2 errors in the same file, starting at: src/a.ts:3', ['error']],
    ['a.c:3:5: error: expected ; before }', ['error']],
    ['src/a.ts(3,1): error TS2304: Cannot find name', ['error']],
    ['panic: runtime error: index out of range', ['error']],
    ['fatal: not a git repository', ['error']],
    ['--- FAIL: TestParse (0.00s)', ['error']],
    ['FAILED tests/test_a.py::test_a', ['error']],
    ['not ok 3 - parses', ['error']],
    ['✖ parses (1.2ms)', ['error']],
    ['expected 3 to equal 4 but FAILED', ['assert']],
    ['##[error]Something went wrong', ['error']],
    ['##[error]Process completed with exit code 2.', ['exit']],
    ['Process completed with exit code 0.', []],
    ['0 errors, 0 warnings', []],
    ['=== FAILURES ===', []],
    ['ErrorBoundary rendered', []],
    // From /code-review medium on PR #5.
    ['SyntaxError: Unexpected token }', ['error']],
    ["src/a.ts(1,2): error TS1005: ';' expected.", ['error']],
    ['ERROR: Could not find a version that satisfies the requirement foo', ['error']],
    ['[ERROR] Failed to execute goal org.apache.maven.plugins', ['error']],
    ['not ok 2 - thing # SKIP no network', []],
    ['not ok 3 - later # TODO', []]
  ];
  for (const [line, expected] of cases) assert.deepStrictEqual(kinds(line), expected, line);
});

test('only the first two stack frames after an error are taken', () => {
  const lines = ['Error: boom', '    at a (a.js:1:1)', '    at b (b.js:1:1)', '    at c (c.js:1:1)', 'next', 'x', 'y', 'z'];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(out.lines.filter((l) => l.kind === 'stack').map((l) => l.index), [1, 2]);
});

test('the failing step holds the last exit line: an earlier continue-on-error step is not it', () => {
  const steps = [{name: 'Run flaky', lines: ['##[error]Process completed with exit code 1.']}, {name: 'Run build', lines: ['error: build broke', '##[error]Process completed with exit code 2.']}];
  assert.strictEqual(extractErrors(steps, 40).failingStep, 'Run build');
});

test('a frame that names an error class or an error file is a frame, and only two are taken', () => {
  const lines = ['Error: boom', '    at new ValidationError (/a/errors.js:1:1)', '    at f (/a/src/error.js:2:2)', '    at g (/a/g.js:3:3)', '    at h (/a/h.js:4:4)'];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(out.lines.filter((l) => l.kind !== 'tail').map((l) => [l.index, l.kind]), [[0, 'error'], [1, 'stack'], [2, 'stack']]);
});

test('over maxLines a traceback is kept beside the error lines that follow it', () => {
  const lines = ['Traceback (most recent call last):', '  File "/a/t.py", line 1, in t', '  File "/a/p.py", line 2, in p', 'ValueError: bad',
    ...Array.from({length: 50}, (_, i) => `FAILED tests/test_${i}.py::t`), '##[error]Process completed with exit code 1.'];
  const out = extractErrors([{name: 'Run pytest', lines}], 10);
  assert.deepStrictEqual(out.lines.slice(0, 4).map((l) => [l.index, l.kind]), [[0, 'stack'], [1, 'stack'], [2, 'stack'], [3, 'error']]);
  assert.strictEqual(out.lines[9].kind, 'exit');
});

test('with no exit line the failing step is the last step with an error line', () => {
  const steps = [{name: 'Run a', lines: ['Error: one']}, {name: 'Run b', lines: ['Error: two']}, {name: 'Run c', lines: ['fine']}];
  assert.strictEqual(extractErrors(steps, 40).failingStep, 'Run b');
});

test('falls back to the tail when nothing matches', () => {
  const lines = Array.from({length: 20}, (_, i) => `line ${i}`);
  const out = extractErrors([{name: '(top)', lines: ['set up']}, {name: 'Run make', lines}, {name: 'Post job cleanup', lines: ['bye']}], 40);
  assert.strictEqual(out.failingStep, null);
  assert.deepStrictEqual(out.lines.map((l) => [l.step, l.index, l.kind]), lines.slice(5).map((_, i) => ['Run make', i + 5, 'tail']));
  assert.deepStrictEqual(extractErrors([], 40), {failingStep: null, lines: [], truncated: false, rules: 2});
});

test('caps at maxLines and sets truncated, keeping the failing step\'s exit and first errors', () => {
  const lines = [...Array.from({length: 100}, (_, i) => `Error: number ${i}`), '##[error]Process completed with exit code 1.'];
  const out = extractErrors([{name: 'Run noisy', lines: ['Error: elsewhere']}, {name: 'Run x', lines}], 10);
  assert.strictEqual(out.truncated, true);
  assert.strictEqual(out.lines.length, 10);
  assert.deepStrictEqual(out.lines.map((l) => l.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 100]);
  assert.ok(out.lines.every((l) => l.step === 'Run x'));
  assert.strictEqual(out.lines[9].kind, 'exit');
});

test('handler validates maxLines range', async () => {
  const invalid = (err) => err.code === 'ARGUMENTS_INVALID';
  for (const maxLines of [0, 201, 1.5, '10']) {
    await assert.rejects(extract({steps: [], maxLines}), invalid, String(maxLines));
  }
  for (const bad of [{}, {steps: 'x'}, {steps: [{name: 'a'}]}, {steps: [{name: 1, lines: []}]}, {steps: [{name: 'a', lines: [1]}]}, null]) {
    await assert.rejects(extract(bad), invalid, JSON.stringify(bad));
  }
  const {output} = await extract({steps: nodeTest.steps});
  assert.deepStrictEqual(output, extractErrors(nodeTest.steps, 40));
  assert.strictEqual((await extract({steps: nodeTest.steps, maxLines: 200})).output.lines.length, 8);
});

test('the module is a part: never listed', () => {
  assert.deepStrictEqual(require('../package.json').countinghouse, {role: 'part'});
});

// From the reviewer's range review of Tasks 1-7 (task-7b).
const conclusions = (...pairs) => pairs.map(([name, conclusion]) => ({name, conclusion}));

test('the jobs API step conclusions decide the failing step: a later if: always() step that fails is not it', () => {
  const steps = [
    {name: '(top)', lines: ['set up']},
    {name: 'Run make build', lines: ['error: build broke', '##[error]Process completed with exit code 2.']},
    {name: 'Run ./upload-logs.sh', lines: ['##[error]Process completed with exit code 1.']},
    {name: 'Post job cleanup', lines: ['bye']}
  ];
  assert.strictEqual(extractErrors(steps, 40).failingStep, 'Run ./upload-logs.sh'); // the log alone guesses wrong
  const api = conclusions(['Set up job', 'success'], ['Lint', 'skipped'], ['Build', 'failure'], ['Upload logs', 'failure'], ['Post Run actions/checkout@v4', 'success'], ['Complete job', 'success']);
  assert.strictEqual(extractErrors(steps, 40, api).failingStep, 'Run make build'); // by position, named steps
  const byName = conclusions(['Set up job', 'success'], ['Run make build', 'failure'], ['Run ./upload-logs.sh', 'failure'], ['Extra', 'success']);
  assert.strictEqual(extractErrors(steps, 40, byName).failingStep, 'Run make build'); // by name, counts differ
});

test('a continue-on-error step (conclusion success) is passed over; conclusions that cannot be matched fall back to the log', () => {
  const steps = [{name: 'Run flaky', lines: ['##[error]Process completed with exit code 1.']}, {name: 'Run test', lines: ['Error: x', '##[error]Process completed with exit code 1.']}];
  assert.strictEqual(extractErrors(steps, 40, conclusions(['Flaky', 'success'], ['Test', 'failure'])).failingStep, 'Run test');
  assert.strictEqual(extractErrors(steps, 40, conclusions(['A', 'failure'], ['B', 'success'], ['C', 'success'])).failingStep, 'Run test');
  assert.strictEqual(extractErrors(steps, 40, conclusions(['A', 'success'])).failingStep, 'Run test');
});

test('console.error blocks do not displace a Jest failure under maxLines', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push('    console.error', `      warning ${i} from tests/error.test.js`, '');
  lines.push('  ● adds › two numbers', '    expect(received).toBe(expected) // Object.is equality', '    Expected: 4', '    Received: 3',
    '      at Object.<anonymous> (tests/add.test.js:3:9)', '##[error]Process completed with exit code 1.');
  const out = extractErrors([{name: 'Run npx jest', lines}], 10);
  assert.deepStrictEqual(out.lines.filter((l) => l.kind !== 'tail').map((l) => l.kind), ['error', 'assert', 'assert', 'assert', 'stack', 'exit']);
});

test('handler validates stepConclusions', async () => {
  const invalid = (err) => err.code === 'ARGUMENTS_INVALID';
  for (const bad of [{steps: [], stepConclusions: 'x'}, {steps: [], stepConclusions: [{name: 'a'}]}, {steps: [], stepConclusions: [{name: 1, conclusion: 'failure'}]}]) {
    await assert.rejects(extract(bad), invalid, JSON.stringify(bad));
  }
  const {output} = await extract({steps: [{name: 'Run a', lines: ['Error: x']}], stepConclusions: conclusions(['A', 'failure'])});
  assert.strictEqual(output.failingStep, 'Run a');
});

// From /code-review medium on PR #30.
test('two steps with one name: the failed one is matched by its place among the same-named steps', () => {
  const steps = [{name: 'Run npm test', lines: ['ok']}, {name: 'Run npm test', lines: ['Error: second', '##[error]Process completed with exit code 1.']}];
  const out = extractErrors(steps, 40, conclusions(['Run npm test', 'success'], ['Run npm test', 'failure']));
  assert.strictEqual(out.failingStep, 'Run npm test');
  assert.strictEqual(out.lines[0].index, 0);
  assert.strictEqual(out.lines.find((l) => l.kind === 'exit').step, 'Run npm test');
  // The second step's lines are ranked first under a tight maxLines.
  const tight = extractErrors([{name: 'Run npm test', lines: ['Error: first']}, ...steps.slice(1)], 2, conclusions(['Run npm test', 'success'], ['Run npm test', 'failure']));
  assert.deepStrictEqual(tight.lines.map((l) => l.text), ['Error: second', '##[error]Process completed with exit code 1.']);
});

test('steps as the jobs API lists them are accepted: a null conclusion and the API\'s other fields', async () => {
  const api = [{name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, started_at: 'x', completed_at: 'y'}, {name: 'Run a', status: 'in_progress', conclusion: null, number: 2}];
  const {output} = await extract({steps: [{name: 'Run a', lines: ['Error: x']}], stepConclusions: api});
  assert.strictEqual(output.failingStep, 'Run a');
});

// JSON log records (bunyan, pino) and other noise in a dogfood run's error
// lines (run 43497750749, the reviewer, 2026-11-13): an info record carrying
// the startup options, the same error record from several processes,
// an assertion whose message embeds a stderr excerpt with a JSON blob, and
// Node's own internal frames.
const record = (o) => JSON.stringify({name: 'countinghouse', hostname: 'runner1', v: 0, time: '2026-11-13T20:03:50.000Z', ...o});
const nonTail = (out) => out.lines.filter((l) => l.kind !== 'tail');

test('a JSON log record below warn is dropped, from the matches and from the tail', () => {
  const lines = [record({pid: 1, level: 30, msg: 'module sandbox: m effective permissions {"fs":[],"limits":{"heapMb":256}} error budget'}),
    record({pid: 1, level: 20, msg: 'debug: an Error happened in a test of errors'})];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(out.lines, []);
});

test('a JSON log record at error level is its e, else its msg, and is an error whatever it says', () => {
  const lines = [record({pid: 9612, level: 50, e: "worker exit on error: ENOENT: no such file or directory, realpath 'D:\\a\\lib\\cli-options.js'", msg: '', time: '2026-11-13T20:03:50.857Z'}),
    record({pid: 9612, level: 50, msg: 'the module stopped', time: '2026-11-13T20:03:51.000Z'}),
    record({pid: 9612, level: 40, msg: 'a warning about an Error', time: '2026-11-13T20:03:52.000Z'}),
    record({pid: 9612, level: 40, msg: 'a plain warning', time: '2026-11-13T20:03:53.000Z'})];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => [l.index, l.kind, l.text]), [
    [0, 'error', "worker exit on error: ENOENT: no such file or directory, realpath 'D:\\a\\lib\\cli-options.js'"],
    [1, 'error', 'the module stopped'],
    [2, 'error', 'a warning about an Error']
  ]);
  assert.strictEqual(out.lines.find((l) => l.index === 3).text, 'a plain warning', 'a warn record reaches the tail as its text');
});

test('an e that is an object (an error serializer) is its message', () => {
  const out = extractErrors([{name: 'Run x', lines: [record({pid: 1, level: 50, err: null, e: {message: 'boom', stack: 'Error: boom\n    at x'}})]}], 40);
  assert.strictEqual(nonTail(out)[0].text, 'boom');
});

test('records in one step the same but for pid and time are one line, with repeats beside its text', () => {
  const e = "worker exit on error: ENOENT: no such file or directory, realpath 'lib/cli-options.js'";
  const lines = [record({pid: 9612, level: 50, e, msg: '', time: 't1'}), 'other', record({pid: 7600, level: 50, e, msg: '', time: 't2'}),
    record({pid: 8296, level: 50, e, msg: '', time: 't3'}), record({pid: 8296, level: 50, e: 'a different one', msg: '', time: 't4'})];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => [l.index, l.text, l.repeats]), [[0, e, 3], [4, 'a different one', undefined]]);
  assert.ok(!out.lines.some((l) => l.index === 2 || l.index === 3), 'the repeats are not in the tail either');
});

test('a repeat in another step is that step\'s own line', () => {
  const r = record({pid: 1, level: 50, e: 'the same failure', msg: '', time: 't'});
  const out = extractErrors([{name: 'Run unit', lines: [r]}, {name: 'Run integration', lines: [r, '##[error]Process completed with exit code 1.']}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => [l.step, l.kind, l.repeats]),
    [['Run unit', 'error', undefined], ['Run integration', 'error', undefined], ['Run integration', 'exit', undefined]]);
  assert.strictEqual(out.failingStep, 'Run integration');
});

test('an object with a level that is not a logger\'s record (no time, or no text field) is an ordinary line', () => {
  const lines = ['{"level":3,"error":"Expected 2 got 3"}', '{"level":10,"name":"config","time":"t"}'];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(out.lines.map((l) => [l.index, l.text]), [[0, lines[0]], [1, lines[1]]], 'both kept as they are (in the tail)');
});

test('a record left out ends no traceback and fills no frame window', () => {
  const info = record({pid: 1, level: 30, msg: 'tick', time: 't'});
  const py = ['Traceback (most recent call last):', '  File "/a/t.py", line 1, in t', info, '  File "/a/p.py", line 2, in p', '  File "/a/q.py", line 3, in q', 'ValueError: bad'];
  assert.deepStrictEqual(nonTail(extractErrors([{name: 'Run pytest', lines: py}], 40)).filter((l) => l.kind === 'stack').map((l) => l.index), [0, 3, 4]);
  const js = ['Error: boom', ...Array.from({length: 12}, () => '    at Module._compile (node:internal/modules/cjs/loader:1929:14)'), '    at a (a.js:1:1)'];
  assert.deepStrictEqual(nonTail(extractErrors([{name: 'Run x', lines: js}], 40)).map((l) => [l.index, l.kind]), [[0, 'error'], [13, 'stack']]);
});

test('JSON embedded in a picked line is cut to 200 characters', () => {
  const blob = JSON.stringify({jobTimeout: 3600000, moduleSandbox: 'audit', more: 'x'.repeat(2000)});
  const line = `AssertionError [ERR_ASSERTION]: the server exited: stderr ${blob} -- end`;
  const out = extractErrors([{name: 'Run x', lines: [line]}], 40);
  const text = nonTail(out)[0].text;
  const at = line.indexOf('{');
  assert.strictEqual(text, `${line.slice(0, at + 200)}… (${line.length - at - 200} more characters)`);
  const short = 'Error: got {"a":1} instead';
  assert.strictEqual(extractErrors([{name: 'Run x', lines: [short]}], 40).lines[0].text, short, 'a short one is kept whole');
});

test('Node\'s internal frames are skipped, and do not use up the two frames an error gets', () => {
  const lines = ['Error: boom', '    at Module._compile (node:internal/modules/cjs/loader:1929:14)', '    at a (a.js:1:1)',
    '    at node:internal/main/run_main_module:33:47', '    at b (b.js:1:1)', '    at c (c.js:1:1)'];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => [l.index, l.kind]), [[0, 'error'], [2, 'stack'], [4, 'stack']]);
});

test('the output names its rules version, so a scenario can tell old extractions from new', async () => {
  assert.strictEqual(extractErrors([{name: 'Run x', lines: ['Error: x']}], 40).rules, 2);
  const {output} = await extract({steps: [{name: 'Run x', lines: ['Error: x']}]});
  assert.strictEqual(output.rules, 2);
});
