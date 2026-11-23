'use strict';
// A failed assertion's expected and actual values, kept with it (`details`),
// outside `lines`: never signed, never counted against maxLines, bounded, and
// screened: an opaque value is withheld and says so. Minimal fixtures written
// from each runner's format; every secret is generated at run time, from a fixed seed.
const test = require('node:test');
const assert = require('node:assert');
const Ajv = require('ajv/dist/2020');
const {extractErrors} = require('../lib/patterns');
const {screenBlock, screenLine, BOUNDS, WITHHELD, LINE_WITHHELD} = require('../lib/values');

const EXIT = '##[error]Process completed with exit code 1.';
// (output after the failure, so the failing step's tail can't be what kept a value)
const AFTER = ['', '', ...Array.from({length: 20}, () => 'more output')];
const run = (lines, maxLines = 40) => extractErrors([{name: 'Run tests', lines: [...lines, ...AFTER, EXIT]}], maxLines);
const valuesOf = (out) => (out.details == null ? [] : out.details.blocks.flatMap((b) => b.values));
const shown = (out) => [...out.lines.map((l) => l.text), ...valuesOf(out)].join('\n');
const both = (out) => shown(out).includes('alpha-expected') && shown(out).includes('beta-actual');

const SHAPES = {
  'node assert under mocha': ['  1) suite', '       compares:', '     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '+ actual - expected', '', "+ 'beta-actual'", "- 'alpha-expected'", '', '      at Context.<anonymous> (test/a.js:15:12)'],
  'node --test, tagged': ['[a.test.js] \u2716 compares (9.4ms)', '[a.test.js]   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:', '[a.test.js]   + actual - expected', '[a.test.js]   ', '[a.test.js]     {', "[a.test.js]   +   v: 'beta-actual'", "[a.test.js]   -   v: 'alpha-expected'", '[a.test.js]     }', '[a.test.js]   ', '[a.test.js]       at TestContext.<anonymous> (test/a.test.js:15:10)'],
  jest: ['  \u25cf suite \u203a compares', '    expect(received).toEqual(expected) // deep equality', '    - Expected  - 1', '    + Received  + 1', '      Object {', '    -   "v": "alpha-expected",', '    +   "v": "beta-actual",', '      }', '      at Object.<anonymous> (src/a.test.js:13:13)'],
  pytest: ['    def test_values():', ">       assert f() == 'alpha-expected'", "E       assert 'beta-actual' == 'alpha-expected'", 'E         - alpha-expected', 'E         + beta-actual', 'tests/test_a.py:4: AssertionError'],
  'go testify': ['=== RUN   TestValues', '    a_test.go:9:', '        \tError Trace:\t/w/a_test.go:9', '        \t            \t/w/b_test.go:3', '        \t            \t/w/c_test.go:7', '        \tError:      \tNot equal:', '        \t            \texpected: "alpha-expected"', '        \t            \tactual  : "beta-actual"', '        \tTest:       \tTestValues', '--- FAIL: TestValues (0.00s)', 'FAIL'],
  rust: ['---- r_eq stdout ----', '', "thread 'r_eq' (815558) panicked at src/lib.rs:1:20:", 'assertion `left == right` failed', '  left: "beta-actual"', ' right: "alpha-expected"', 'note: run with `RUST_BACKTRACE=1`']
};

for (const [name, lines] of Object.entries(SHAPES)) {
  test(`${name}: both values are kept with the failure`, () => {
    const out = run(lines);
    assert.ok(both(out), JSON.stringify(out, null, 1));
  });
}

test('the failure\'s location comes with its values, when maxLines left it out', () => {
  const noise = Array.from({length: 45}, (_, i) => `Error: noise ${i}`);
  const out = run([...noise, ...SHAPES['node assert under mocha']]);
  assert.ok(out.lines.length <= 40);
  assert.ok(valuesOf(out).some((v) => v.includes('test/a.js:15:12')), JSON.stringify(out.details));
  assert.ok(out.details.blocks[0].verdict.includes('AssertionError'));
});

test('`lines` are the same with or without the values: nothing here can move a signature', () => {
  for (const lines of Object.values(SHAPES)) {
    const out = run(lines);
    const indexes = new Set(out.lines.map((l) => l.index));
    for (const b of (out.details || {blocks: []}).blocks) assert.ok(indexes.has(b.index) || b.verdict.length > 0);
    assert.ok(!out.lines.some((l) => l.kind === 'value'));
  }
});

test('a log with no failed assertion has no details', () => {
  assert.ok(!('details' in run(['npm error code ELIFECYCLE', 'something else'])));
  assert.deepStrictEqual(extractErrors([], 40), {failingStep: null, lines: [], truncated: false, rules: 4});
});

test('the block ends at the next test: a passing line, another failure, a frame', () => {
  const out = run(['AssertionError: one', "+ 'x-value'", '\u2714 passes', "+ 'not-this'", 'AssertionError: two', "- 'y-value'", '  2) next', "- 'nor-this'"]);
  const v = valuesOf(out).join('\n');
  assert.ok(v.includes('x-value') && v.includes('y-value'));
  assert.ok(!v.includes('not-this') && !v.includes('nor-this'), v);
});

test('another job\'s interleaved tag is not part of the block', () => {
  const out = run(['[a.js] AssertionError: one', "[b.js] + 'from-b'", "[a.js] + 'from-a'"]);
  const v = valuesOf(out).join('\n');
  assert.ok(v.includes('from-a') && !v.includes('from-b'), v);
});

test('bounds: per failure in lines and characters, per call in lines, each saying it cut', () => {
  const long = (n) => ['AssertionError: long', ...Array.from({length: n}, (_, i) => `+ value number ${i}`), ''];
  const one = run(long(BOUNDS.PER_LINES + 3)).details.blocks[0];
  assert.strictEqual(one.values.length, BOUNDS.PER_LINES);
  assert.strictEqual(one.cut, true);
  const whole = run(long(BOUNDS.PER_LINES)).details.blocks[0];
  assert.strictEqual(whole.cut, false);

  const wide = run(['AssertionError: wide', ...Array.from({length: 8}, (_, i) => `+ ${'word '.repeat(90)}${i}`)]).details.blocks[0];
  assert.ok(wide.values.join('').length <= BOUNDS.PER_CHARS);
  assert.strictEqual(wide.cut, true);

  const many = [];
  for (let i = 0; i < 8; i++) many.push(`AssertionError: number ${i}`, ...Array.from({length: BOUNDS.PER_LINES}, (_, j) => `+ value ${i} ${j}`), '', '');
  const d = run(many, 200).details;
  assert.ok(d.blocks.flatMap((b) => b.values).length <= BOUNDS.ALL_LINES);
  assert.ok(d.omittedBlocks > 0, 'the blocks left out are counted');
  assert.strictEqual(d.blocks.length + d.omittedBlocks, 8);
});

test('the output matches the schema, at its bounds', () => {
  const o = require('../schema.json').patternService.extract.output;
  const valid = new Ajv({strict: false}).compile(o);
  const many = [];
  for (let i = 0; i < 8; i++) many.push(`AssertionError: number ${i}`, ...Array.from({length: 14}, (_, j) => `+ value ${i} ${j} ${'word '.repeat(30)}`), '', '');
  const full = run(many, 200);
  assert.ok(full.details != null && full.details.omittedBlocks > 0, 'at its bounds');
  for (const out of [full, ...Object.values(SHAPES).map((l) => run(l))]) assert.ok(valid(out), JSON.stringify(valid.errors));
});

// What stays readable: a value that says what failed.
test('ordinary values are not withheld', () => {
  for (const v of ["+ undefined", "- 'REQUEST_INVALID'", '+   mayElicit: false,', "+   why: 'client settings unreadable'", '-   why: null', '  at Context.<anonymous> (test/auth/20-request-body-limits.js:153:12)',
    'at TestContext.<anonymous> (D:\\a\\repo\\repo\\test\\client-conditions.test.js:336:10)', '+ 1700000000000', '- 45072705084', "+ 'x86_64-apple-darwin'", '+ TS2304', '- node22', "+ 'countinghouse\u2026; next'", '+ {"code":"MODULE_NOT_LISTED","retryable":false}',
    '- CountinghouseErrorCatalogueEntry', '+ <githubToken>', '+ aDaemonThatGaveUpPastThePlainDeadlineIsSeen']) {
    assert.strictEqual(screenLine(v), v, v);
  }
  const pair = ['+ undefined', "- 'REQUEST_INVALID'"];
  assert.deepStrictEqual(screenBlock(pair), pair);
  assert.deepStrictEqual(screenBlock(['+ 42', '- 43']), ['+ 42', '- 43']);
  assert.deepStrictEqual(screenBlock(['+ true', '- false']), ['+ true', '- false']);
  assert.deepStrictEqual(screenBlock(['+ 45072705084', '- 45072705085']), ['+ 45072705084', '- 45072705085'], 'two ids compared');
});

// Generated values from a fixed seed, so a run is the same every time. Short
// values can read as a word or a number by chance, so those kinds pin a rate.
let state = 0x2f6e2b1;
const next = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const bytes = (n) => Buffer.from(Array.from({length: n}, () => Math.floor(next() * 256)));
const b64 = (n) => bytes(n).toString('base64');
const hex = (n) => bytes(n).toString('hex');
const mixed = (n) => {
  const pool = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  while (s.length < n) s += pool[Math.floor(next() * pool.length)];
  // (a digit inside, as a generated value has)
  return `${s.slice(0, 2)}7${s.slice(3, n - 2)}4${s.slice(n - 1)}`;
};
const absent = (out, secret, why) => assert.ok(!out.join('\n').includes(secret), `${why}: ${out.join(' / ')}`);

test('opaque values are withheld, and the line says so', () => {
  const kinds = [['base64, long', () => b64(48), 0], ['base64, medium', () => b64(18), 0.005], ['hex, 40', () => hex(20), 0], ['hex, 16', () => hex(8), 0],
    ['hex, 8', () => `${hex(3)}7a`, 0], ['mixed, short', () => mixed(8), 0.005], ['mixed, medium', () => mixed(16), 0]];
  for (const [why, make, allowed] of kinds) {
    let shown = 0;
    let lines = 0;
    for (let round = 0; round < 400; round++) {
      const secret = make();
      for (const line of [`+ ${secret}`, `- '${secret}'`, `+   token: "${secret}",`, `+ {"key":"${secret}"}`, `[a.test.js]   - '${secret}'`]) {
        lines++;
        const out = screenLine(line);
        if (out.includes(secret)) shown++;
        else assert.ok(out.includes(WITHHELD) || out === LINE_WITHHELD, `${why}: ${out}`);
      }
    }
    assert.ok(shown / lines <= allowed, `${why}: ${shown} of ${lines} shown`);
  }
});

test('a key wrapped over diff lines, its BEGIN line out of sight, is withheld down to its short last line', () => {
  for (let round = 0; round < 100; round++) {
    const key = b64(120);
    const parts = key.match(/.{1,64}/g);
    const out = screenBlock(parts.map((p) => `+ ${p}`));
    for (const p of parts) absent(out, p, 'a wrapped key line');
  }
  assert.ok(!screenBlock([`+ ${b64(48)}`, '+ aB9x=='])[1].includes('aB9x'), 'the short last line of a wrapped value');
});

test('a secret split across the expected and actual lines is withheld on both', () => {
  let shown = 0;
  let pairs = 0;
  for (let round = 0; round < 400; round++) {
    const secret = mixed(12);
    const [x, y] = [secret.slice(0, 6), secret.slice(6)];
    for (const pair of [[`+ ${x}`, `- ${y}`], [`- '${x}'`, `+ '${y}'`], [`+   ${x},`, `+   ${y}`]]) {
      pairs++;
      const out = screenBlock(pair).join('\n');
      if (out.includes(x) || out.includes(y)) shown++;
    }
  }
  assert.ok(shown / pairs <= 0.005, `${shown} of ${pairs} pairs showed a half`);
  // short pieces, each too short to judge alone
  assert.deepStrictEqual(screenBlock(['+ aB3d', '- E9xK']), [`+ ${WITHHELD}`, `- ${WITHHELD}`]);
});

test('a line it cannot judge is withheld whole: a control or hidden character', () => {
  for (const c of [0x07, 0x1b, 0x7f, 0x85, 0xad, 0x200b, 0x202e, 0x2066, 0xfeff]) {
    assert.strictEqual(screenLine(`+ value${String.fromCharCode(c)}more`), LINE_WITHHELD, c.toString(16));
  }
  assert.strictEqual(screenLine(`+ a${String.fromCodePoint(0xe0041)}b`), LINE_WITHHELD);
});

test('quotes pair up: JSON keys and sentences stay readable, and a value after an apostrophe is still judged', () => {
  const json = '{"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[{"type":"text","text":"Changing a setting is refused"}]}}';
  assert.strictEqual(screenLine(json), json);
  const secret = mixed(16);
  for (const line of [`it's not '${secret}'`, `{"isError":true,"key":"${secret}","text":"a sentence here"}`]) {
    absent([screenLine(line)], secret, 'after another quote');
  }
});

test('text it cannot judge is withheld: another script, a value cut at the line\'s end', () => {
  const other = `+ '${String.fromCharCode(0x416, 0x431, 0x433)}'`;
  assert.ok(screenLine(other).includes(WITHHELD), screenLine(other));
  const cut = screenLine('+ some words and then partOfAVal\u2026');
  assert.ok(cut.includes(WITHHELD) && !cut.includes('partOfAVal'), cut);
  assert.ok(cut.includes('some words'), cut);
});

test('what reaches `details` has been screened, the verdict too', () => {
  const secret = mixed(16);
  const out = run([`AssertionError: '${secret}' == 'x'`, `+ '${secret}'`, `- '${b64(30)}'`]);
  const b = out.details.blocks[0];
  absent([b.verdict, ...b.values], secret, 'details');
});
