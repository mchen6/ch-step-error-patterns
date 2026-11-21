'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {extractErrors} = require('../lib/patterns');
const {CountinghouseError} = require('countinghouse/lib/countinghouse-error');
// the handler as the runtime calls it: (input, ctx), ctx.error the runtime's
const ctx = {error: (code, message, details) => CountinghouseError.module(code, message, details)};
const handler = require('../handlers/patternService/extract');
const extract = Object.assign((input) => handler(input, ctx), handler);
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
  assert.deepStrictEqual(extractErrors([], 40), {failingStep: null, lines: [], truncated: false, rules: 3});
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
  const invalid = (err) => err.code === 'INPUT_REJECTED';
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
  const invalid = (err) => err.code === 'INPUT_REJECTED';
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
  assert.strictEqual(text, `${line.slice(0, at + 200)}…`, 'a plain …: no count of what was cut, which would change the signature');
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
  assert.strictEqual(extractErrors([{name: 'Run x', lines: ['Error: x']}], 40).rules, 3);
  const {output} = await extract({steps: [{name: 'Run x', lines: ['Error: x']}]});
  assert.strictEqual(output.rules, 3);
});

// The reviewer's review of #1 (2026-11-13).
test('a record whose e is a whole stack is its first line', () => {
  const stack = 'Error: worker exit\n    at a (a.js:1:1)\n' + '    at b (b.js:2:2)\n'.repeat(500);
  const out = extractErrors([{name: 'Run x', lines: [record({pid: 1, level: 50, e: stack})]}], 40);
  assert.strictEqual(nonTail(out)[0].text, 'Error: worker exit');
});

test('every line is at most 500 characters, taken in and given back, cut with …', () => {
  const long = `Error: ${'x'.repeat(2000)}`;
  const out = extractErrors([{name: 'Run x', lines: [long, ...Array.from({length: 20}, (_, i) => `t${i} ${'y'.repeat(900)}`)]}], 40);
  assert.ok(out.lines.length > 1);
  for (const l of out.lines) assert.ok(l.text.length <= 500, String(l.text.length));
  assert.strictEqual(out.lines[0].text, `${long.slice(0, 499)}…`);
});

test('a record cut by the line bound (as ch-step-log-clean cuts it) is still read as a record', () => {
  const full = record({pid: 9612, level: 50, e: `worker exit on error: ENOENT ${'z'.repeat(700)}`, msg: ''});
  const cut = `${full.slice(0, 499)}…`;
  // bunyan's own order: name, hostname, pid, level, msg, time, v
  const info = JSON.stringify({name: 'countinghouse', hostname: 'runner1', pid: 1, level: 30, msg: `tick ${'q'.repeat(700)}`, time: 't', v: 0});
  const out = extractErrors([{name: 'Run x', lines: [cut, `${info.slice(0, 499)}…`]}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => [l.kind, l.text.slice(0, 40)]), [['error', 'worker exit on error: ENOENT zzzzzzzzzzz']]);
  assert.ok(!out.lines.some((l) => l.index === 1), 'a cut info record is dropped too');
});

test('the schema bounds every line at 500 characters, in the input and the output', () => {
  const x = require('../schema.json').patternService.extract;
  assert.strictEqual(x.input.properties.steps.items.properties.lines.items.maxLength, 500);
  assert.strictEqual(x.output.properties.lines.items.properties.text.maxLength, 500);
});

test('Node\'s internal frames are not in the tail either, indented or not', () => {
  const lines = ['line a', '    at Module._compile (node:internal/modules/cjs/loader:1929:14)', 'at node:internal/main/run_main_module:33:47', 'line b'];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(out.lines.map((l) => l.index), [0, 3]);
});

// The real case from #151's run (the reviewer, 2026-11-13): mocha's summary.
const MOCHA = [
  '  27 passing (2m)',
  '  1 failing',
  '',
  '  1) remote 07: usage records for remote calls, and the call id across every hop',
  '       the call id is carried unchanged …:',
  '     TypeError: Cannot read properties of null (reading \'usageCall\')',
  '      at Context.<anonymous> (test/remote/07-usage-records.js:212:31)',
  '      at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
  '',
  '##[error]Process completed with exit code 1.'
];

test('mocha\'s numbered failure: the title, its lines and its error, paired, with the failure\'s number', () => {
  const out = extractErrors([{name: 'Run npm test', lines: MOCHA}], 40);
  const paired = out.lines.filter((l) => l.failure === 1);
  assert.deepStrictEqual(paired.map((l) => [l.index, l.kind]), [[3, 'error'], [4, 'error'], [5, 'error']]);
  assert.strictEqual(paired[2].text, "     TypeError: Cannot read properties of null (reading 'usageCall')");
  assert.ok(out.lines.some((l) => l.index === 6 && l.kind === 'stack'), 'its first frame is kept');
  assert.ok(!out.lines.some((l) => l.index === 7), 'Node\'s internal frame is not');
});

test('a mocha failure survives a noisy log: ranked above the generic matches, below the exit line', () => {
  const noise = Array.from({length: 60}, (_, i) => `ERROR something unrelated ${i}`);
  const out = extractErrors([{name: 'Run npm test', lines: [...noise, ...MOCHA]}], 5);
  const texts = out.lines.map((l) => l.text);
  assert.ok(texts.includes("     TypeError: Cannot read properties of null (reading 'usageCall')"), JSON.stringify(texts));
  assert.ok(texts.includes('  1) remote 07: usage records for remote calls, and the call id across every hop'));
  assert.ok(texts.includes('##[error]Process completed with exit code 1.'));
  assert.strictEqual(out.truncated, true);
});

test('a numbered line with no error after it (mocha\'s progress line) is not a failure', () => {
  const lines = ['  remote 07', '      ✔ one', '      1) the call id is carried unchanged', '      ✔ two', 'done'];
  const out = extractErrors([{name: 'Run npm test', lines}], 40);
  assert.ok(!out.lines.some((l) => l.failure != null), JSON.stringify(out.lines));
});

// /code-review medium of the review fixes.
test('a record whose text starts with a newline is its first non-empty line', () => {
  const out = extractErrors([{name: 'Run x', lines: [JSON.stringify({level: 50, time: 1, msg: '\nError: connect ECONNREFUSED'})]}], 40);
  assert.strictEqual(nonTail(out)[0].text, 'Error: connect ECONNREFUSED');
});

test('a cut record reads its top-level members only: a nested level or msg is not its own', () => {
  const long = JSON.stringify({name: 'a', hostname: 'h', pid: 1, req: {level: 10, msg: 'nested'}, level: 50, err: {message: 'boom', stack: 'x'.repeat(900)}});
  const out = extractErrors([{name: 'Run x', lines: [`${long.slice(0, 499)}…`]}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => [l.kind, l.text]), [['error', 'boom']]);
});

test('a cut record gives the same text as the whole one: the same key order and level names', () => {
  const whole = {level: 'ERROR', time: 't', msg: 'request failed', e: 'TypeError: x', pad: 'p'.repeat(900)};
  const short = {...whole, pad: 'p'};
  const textOf = (line) => nonTail(extractErrors([{name: 'Run x', lines: [line]}], 40)).map((l) => l.text);
  assert.deepStrictEqual(textOf(JSON.stringify(short)), ['TypeError: x']);
  assert.deepStrictEqual(textOf(`${JSON.stringify(whole).slice(0, 499)}…`), ['TypeError: x']);
});

test('mocha pairing needs deeper indentation and an error name: other numbered lines are not failures', () => {
  const inline = ['    1) does b', '  other suite', '    Error: retrying', '    ✔ c'];
  assert.ok(!extractErrors([{name: 'Run x', lines: inline}], 40).lines.some((l) => l.failure != null), 'the next suite ends it');
  const list = ['  1) Install deps', 'npm error code ERESOLVE'];
  assert.ok(!extractErrors([{name: 'Run x', lines: list}], 40).lines.some((l) => l.failure != null), 'a numbered list and a later error');
  const noName = ['  1) suite', '       test', '     something failed: ERROR in config'];
  assert.ok(!extractErrors([{name: 'Run x', lines: noName}], 40).lines.some((l) => l.failure != null), 'no error name at the start');
});

test('a cut never splits a surrogate pair', () => {
  const line = `Error: ${'a'.repeat(491)}\u{1F600}${'b'.repeat(10)}`;
  const text = extractErrors([{name: 'Run x', lines: [line]}], 40).lines[0].text;
  assert.strictEqual(text, `Error: ${'a'.repeat(491)}…`);
});

// The reviewer's re-review of #1 (2026-11-13).
test('a test runner\'s passing line is not an error, whatever it names', () => {
  const lines = ['  ✔ retries the call (was: TypeError: x)', '    ✓ handles Error input', 'TypeError: real'];
  const out = extractErrors([{name: 'Run x', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => l.index), [2]);
});

test('step names are given back at most 200 characters; the schema bounds them and the lines list', () => {
  const name = `Run ${'n'.repeat(400)}`;
  const out = extractErrors([{name, lines: ['Error: x', '##[error]Process completed with exit code 1.']}], 40);
  assert.strictEqual(out.failingStep, `${name.slice(0, 199)}…`);
  for (const l of out.lines) assert.strictEqual(l.step.length, 200);
  const o = require('../schema.json').patternService.extract.output;
  assert.deepStrictEqual([o.properties.failingStep.maxLength, o.properties.lines.items.properties.step.maxLength, o.properties.lines.maxItems], [200, 200, 200]);
});

// The final pass on the packs (A5): a passing test's line names its test,
// whatever the test's name says; a file name or a coverage row is not an
// error either.
test('a passing line of go test, jest, pytest and TAP is not an error, whatever its test is named', () => {
  const lines = ['=== RUN   TestParseError', '--- PASS: TestParseError (0.00s)', 'PASS src/errors/HttpError.test.ts',
    'tests/test_errors.py::test_raises_ValueError PASSED                      [ 25%]', 'ok   github.com/acme/errors 0.003s',
    'ok 3 - throws a TypeError', '--- FAIL: TestWrapError (0.00s)', 'FAIL src/api/user.test.ts'];
  const out = extractErrors([{name: 'Run t', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => l.index), [6, 7]);
});

test('an error\'s name followed by a file extension or a table bar (a file, a coverage row) is not an error', () => {
  const lines = [' HttpError.ts         |   100   |   100    |   100   |   100   |', ' ValidationError.ts   |   100   |   100    |   100   |   100   |',
    'Compiling src/errors/HttpError.ts', 'TypeError: real', 'threw a RangeError.', 'src/errors/HttpError.test.ts:3 ReferenceError: x is not defined'];
  const out = extractErrors([{name: 'Run t', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => l.index), [3, 4, 5]);
});

test('npm\'s warnings and a build\'s count of zero errors are not errors', () => {
  const lines = ["npm warn deprecated domexception@4.0.0: Use your platform's native DOMException instead", '    0 Error(s)', '0 errors', 'Error: real'];
  const out = extractErrors([{name: 'Run t', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => l.index), [3]);
});

// A8: the line that says what failed is kept beside its verdict, however
// many verdicts the step has.
test('go test: a failed test\'s indented lines are kept, after its --- FAIL: line and between its === RUN and --- FAIL:', () => {
  const lines = ['=== RUN   TestSum0', '    sum_test.go:12: Sum(1, 2) = 4; want 3', '--- FAIL: TestSum0 (0.00s)',
    '=== RUN   TestSum1', '--- FAIL: TestSum1 (0.00s)', '    sum_test.go:20: Sum(2, 2) = 5; want 4', '    sum_test.go:21: and more',
    '=== RUN   TestSum2', '    sum_test.go:30: Sum(3, 3) = 7; want 6', '--- FAIL: TestSum2 (0.00s)', 'FAIL', 'FAIL\tgithub.com/acme/proj/pkg/sum\t0.004s', 'FAIL', '##[error]Process completed with exit code 1.'];
  const out = extractErrors([{name: 'Run go test ./...', lines}], 40);
  const kept = new Set(out.lines.map((l) => l.index));
  for (const i of [1, 5, 6, 8]) assert.ok(kept.has(i), `line ${i}: ${lines[i]}`);
  assert.ok(!out.lines.some((l) => l.kind === 'tail'), 'enough matches: no tail');
  assert.strictEqual(out.lines.find((l) => l.index === 1).kind, 'assert');
});

test('ESLint stylish: the file line above each file\'s rows is kept', () => {
  const lines = ['> eslint .', '/home/runner/work/app/app/src/api/user.js', "  12:7   error  'token' is assigned a value but never used  no-unused-vars",
    '  30:1   error  Unexpected console statement                 no-console', '/home/runner/work/app/app/src/util/date.js',
    "   3:10  error  'parse' is defined but never used            no-unused-vars", '✖ 3 problems (3 errors, 0 warnings)', '##[error]Process completed with exit code 1.'];
  const out = extractErrors([{name: 'Run npm run lint', lines}], 40);
  const byIndex = new Map(out.lines.map((l) => [l.index, l.kind]));
  assert.strictEqual(byIndex.get(1), 'stack');
  assert.strictEqual(byIndex.get(4), 'stack');
  assert.strictEqual(byIndex.has(0), false);
});

test('rustc: the --> line after each error is kept', () => {
  const lines = ['error[E0308]: mismatched types', ' --> src/main.rs:4:18', '  |', 'error[E0425]: cannot find value `y` in this scope', ' --> src/lib.rs:9:5',
    'error[E0599]: no method named `foo` found', ' --> src/bar.rs:21:9', 'error: could not compile `proj` (bin "proj") due to 3 previous errors', '##[error]Process completed with exit code 101.'];
  const out = extractErrors([{name: 'Run cargo build', lines}], 40);
  const byIndex = new Map(out.lines.map((l) => [l.index, l.kind]));
  for (const i of [1, 4, 6]) assert.strictEqual(byIndex.get(i), 'stack', lines[i]);
});

test('cargo test: each panic and its message are kept', () => {
  const lines = ['test tests::it_adds ... FAILED', 'test tests::it_subs ... FAILED', '', 'failures:', '', '---- tests::it_adds stdout ----',
    "thread 'tests::it_adds' panicked at src/lib.rs:14:9:", 'assertion `left == right` failed', '  left: 4', ' right: 5', '',
    '---- tests::it_subs stdout ----', "thread 'tests::it_subs' panicked at src/lib.rs:20:9:", 'assertion `left == right` failed', '  left: 1', ' right: 0',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace', '', 'test result: FAILED. 1 passed; 2 failed; 0 ignored', 'error: test failed, to rerun pass `--lib`', '##[error]Process completed with exit code 101.'];
  const out = extractErrors([{name: 'Run cargo test', lines}], 40);
  const byIndex = new Map(out.lines.map((l) => [l.index, l.kind]));
  for (const i of [6, 12]) assert.strictEqual(byIndex.get(i), 'error', lines[i]);
  for (const i of [7, 8, 9, 13, 14, 15]) assert.strictEqual(byIndex.get(i), 'assert', lines[i]);
  assert.strictEqual(byIndex.has(16), false, 'the note is not the panic\'s');
});

// (the final pass on the packs, A4) Only the failing step's matches decide whether its tail is added:
// warnings in an earlier step do not keep it out.
test('the tail is added when the failing step has fewer than five matches, whatever other steps hold', () => {
  const steps = [{name: 'Run npm ci', lines: ['ERROR: one', 'ERROR: two', 'ERROR: three', 'ERROR: four', 'ERROR: five']},
    {name: 'Run npm test', lines: ['> jest', 'some output', 'FAIL src/a.test.js', 'more output', '##[error]Process completed with exit code 1.']}];
  const out = extractErrors(steps, 40);
  assert.strictEqual(out.failingStep, 'Run npm test');
  assert.deepStrictEqual(out.lines.filter((l) => l.step === 'Run npm test').map((l) => l.kind), ['tail', 'tail', 'error', 'tail', 'exit']);
});

// The medium on A5/A8.
test('a verdict that reads as an assertion keeps its detail too: ESLint\'s Expected rows, a go test named for an assertion', () => {
  const out = extractErrors([{name: 'Run t', lines: ['/repo/src/a.js', '  3:1  error  Expected indentation of 2 spaces but found 4  indent',
    '--- FAIL: TestAssertionHelper (0.00s)', '    x_test.go:9: got 1 want 2', '##[error]Process completed with exit code 1.']}], 40);
  const byIndex = new Map(out.lines.map((l) => [l.index, l.kind]));
  assert.strictEqual(byIndex.get(0), 'stack');
  assert.strictEqual(byIndex.get(3), 'assert');
});

test('more passing lines and zero counts: tsc\'s Found 0 errors, npm 9\'s WARN, a trailing ... ok', () => {
  const lines = ['Found 0 errors. Watching for file changes.', "npm WARN deprecated domexception@4.0.0: Use your platform's native DOMException instead",
    'test tests::returns_ParseError ... ok', 'test_raises_TypeError (tests.T) ... ok', 'Found 2 errors.', 'Results: 2 FAILED, 5 PASSED',
    'tests/test_p.py::test_parse[raises ValueError] PASSED                [ 50%]', '[gw1] [ 25%] PASSED tests/test_x.py::test_raises_ValueError',
    'ERROR: retrying migration 0042 ... ok'];
  const out = extractErrors([{name: 'Run t', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => l.index), [4, 5, 8]);
});

test('go test -v with parallel tests: a detail is the test\'s whose output it is (=== NAME, === CONT), never another\'s', () => {
  const lines = ['=== RUN   TestA', '=== PAUSE TestA', '=== RUN   TestB', '=== PAUSE TestB', '=== CONT  TestA', '=== CONT  TestB', '=== NAME  TestA',
    '    a_test.go:3: a log line from A', '=== NAME  TestB', '    b_test.go:4: got 1 want 2', '--- PASS: TestA (0.00s)', '--- FAIL: TestB (0.00s)', 'FAIL', '##[error]Process completed with exit code 1.'];
  const out = extractErrors([{name: 'Run go test -v ./...', lines}], 40);
  const byIndex = new Map(out.lines.map((l) => [l.index, l.kind]));
  assert.strictEqual(byIndex.get(9), 'assert');
  assert.notStrictEqual(byIndex.get(7), 'assert', 'A passed: its line is not B\'s detail');
});

test('a panic\'s message stops at its backtrace', () => {
  const lines = ["thread 'main' panicked at src/main.rs:2:5:", 'boom', 'stack backtrace:', '   0: rust_begin_unwind', '   1: core::panicking::panic_fmt', '##[error]Process completed with exit code 101.'];
  const out = extractErrors([{name: 'Run cargo run', lines}], 40);
  const byIndex = new Map(out.lines.map((l) => [l.index, l.kind]));
  assert.strictEqual(byIndex.get(1), 'assert');
  for (const i of [2, 3, 4]) assert.notStrictEqual(byIndex.get(i), 'assert', lines[i]);
});

// The medium's rounds 2 and 3.
test('npm 6-9\'s closing ERR! block does not keep the tail, which holds the cause, out', () => {
  const lines = ["Module not found: Can't resolve './x'", 'npm ERR! code ELIFECYCLE', 'npm ERR! errno 1', 'npm ERR! app@1.0.0 build: `webpack`', 'npm ERR! Exit status 1',
    'npm ERR! A complete log of this run can be found in:', 'npm ERR!     /home/runner/.npm/_logs/x-debug.log', '##[error]Process completed with exit code 1.'];
  const out = extractErrors([{name: 'Run npm run build', lines}], 40);
  assert.ok(out.lines.some((l) => l.index === 0), 'the cause is kept');
});

test('npm 10\'s closing block does not keep the tail out either; npm 8\'s ERESOLVE cause is kept; the log file\'s line is no error', () => {
  const ten = ["Module not found: Can't resolve './x'", 'npm error Lifecycle script `build` failed with error:', 'npm error code 1', 'npm error path /home/runner/work/app',
    'npm error workspace app@1.0.0', 'npm error location /home/runner/work/app', 'npm error command failed', 'npm error command sh -c webpack',
    'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-21T10_11_12_345Z-debug-0.log', '##[error]Process completed with exit code 1.'];
  const out = extractErrors([{name: 'Run npm run build', lines: ten}], 40);
  assert.ok(out.lines.some((l) => l.index === 0), 'the cause is kept');
  assert.notStrictEqual(out.lines.find((l) => l.index === 8).kind, 'error');
  const eight = ['npm ERR! code ERESOLVE', 'npm ERR! ERESOLVE unable to resolve dependency tree', ...Array.from({length: 20}, (_, i) => `npm ERR! peer dep line ${i}`), '##[error]Process completed with exit code 1.'];
  const kept = extractErrors([{name: 'Run npm ci', lines: eight}], 40).lines;
  assert.deepStrictEqual([0, 1].map((i) => kept.find((l) => l.index === i).kind), ['error', 'error']);
});

test('passing lines of cargo\'s doctests and should_panic tests, unittest -v with a docstring and pytest\'s count style are no errors', () => {
  const lines = ['test src/lib.rs - ParseError (line 12) ... ok', 'test tests::rejects - should panic ... ok', 'test_bad_input (tests.T.test_bad_input)',
    'Raises TypeError on bad input ... ok', 'tests/test_p.py::test_raises_ValueError PASSED [ 3/40]', '[gw0] PASSED tests/test_x.py::test_raises_ValueError', 'TypeError: real'];
  const out = extractErrors([{name: 'Run t', lines}], 40);
  assert.deepStrictEqual(nonTail(out).map((l) => l.index), [6]);
});
