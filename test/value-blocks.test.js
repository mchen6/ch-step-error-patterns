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

// Card numbers are built here, with their check digit (Luhn), never written out.
const card = (prefix, length) => {
  const body = `${prefix}${'0192837465'.repeat(2)}`.slice(0, length - 1);
  const sum = [...body].reverse().reduce((n, c, i) => { const d = Number(c) * (i % 2 === 0 ? 2 : 1); return n + (d > 9 ? d - 9 : d); }, 0);
  return `${body}${(10 - sum % 10) % 10}`;
};
const CARD16 = card(4, 16).match(/.{4}/g);
const CARD15 = (([, ...groups]) => groups)(/^(.{4})(.{6})(.{5})$/.exec(card(37, 15)));

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

test('`lines` are the same whatever the values are: nothing here can move a signature', () => {
  const lines = SHAPES['node assert under mocha'];
  const other = lines.map((l) => l.replace('beta-actual', 'gamma-other'));
  assert.notDeepStrictEqual(valuesOf(run(lines)), valuesOf(run(other)));
  assert.deepStrictEqual(run(lines).lines, run(other).lines);
  for (const shape of Object.values(SHAPES)) assert.deepStrictEqual(Object.keys(run(shape)).filter((k) => k !== 'details'), ['failingStep', 'lines', 'truncated', 'rules']);
});

test('a log with no failed assertion has no details', () => {
  assert.ok(!('details' in run(['npm error code ELIFECYCLE', 'something else'])));
  assert.deepStrictEqual(extractErrors([], 40), {failingStep: null, lines: [], truncated: false, rules: 4});
});

test('the block ends at the next test: a passing line, another failure, a frame', () => {
  const out = run(['AssertionError: one', "+ 'x-value'", '\u2714 passes', "+ 'not-this'", '     AssertionError: two', "- 'y-value'", '  2) next', "- 'nor-this'"]);
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
// values can read as a word or a number by chance, so those kinds have a limit:
// a limit for the test, allowing for random variation, not a measured rate.
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

// Wherever a value sits, it is judged the same.
const V = 'xkqjeuzvboatyhwmda';
test('a value is judged wherever it sits: after a key or scheme, in a URL, an open quote, as a map key, in brackets', () => {
  for (const line of [`password=${V} rejected`, `Authorization: Bearer ${V}`, ['postgres://admin', `${V}@db.invalid/x`].join(':'), `token: "${V}`, `token ${V}7 rejected`,
    `"${V}": 1`, `"${V} "`, `+ <${V}>`, `+ ${V}`, `some words ${V} more words`]) {
    const out = screenLine(line);
    assert.ok(!out.includes(V) && out.includes(WITHHELD), `${line} -> ${out}`);
  }
});

test('separators do not cut a generated value into parts that pass', () => {
  for (const v of ['aB3-x9Q-7kL-pQ2-zR8-m4T', 'aB3_x9Q_7kL_pQ2_zR8', 'aB3d/x9Qz/7kLm/pQ2w', '550e8400-e29b-41d4-a716-446655440000']) {
    for (const line of [`+ ${v}`, `token: "${v}"`, `token ${v} rejected`]) {
      const out = screenLine(line);
      for (const part of v.split(/[-_/]/)) assert.ok(!out.includes(part), `${line} -> ${out}`);
    }
  }
});

test('an escaped value is withheld: the escape text is the value', () => {
  const x = (t) => [...t].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join('');
  const u = (t) => [...t].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  for (const line of [`+ "${x('AKIA9Q')}"`, `"k":"${u('aB3d')}"`]) {
    assert.ok(screenLine(line).includes(WITHHELD), screenLine(line));
    assert.ok(!screenLine(line).includes('\\x') && !screenLine(line).includes('\\u'), screenLine(line));
  }
});

test('pieces are joined across digits, punctuation lines and concatenated literals', () => {
  const pieces = CARD16;
  assert.ok(!screenBlock(pieces.map((p, i) => `${i % 2 ? '-' : '+'} ${p}`)).join('').includes(CARD16[0]));
  assert.ok(!screenBlock(['+ aB3d', '  }', '- E9xK']).join('').includes('aB3d'));
  const out = screenBlock(["  'aB3d' + 'x9Qz' + '7kLm'"]).join('');
  assert.ok(!out.includes('aB3d') && !out.includes('7kLm'), out);
  assert.deepStrictEqual(screenBlock(['+ 200', '- 404']), ['+ 200', '- 404'], 'two status codes');
  assert.deepStrictEqual(screenBlock(['+ foo', '- bar']), ['+ foo', '- bar'], 'two short words');
});

test('readable text stays readable in every position', () => {
  for (const line of ['+ <anonymous>', '  at Object.<anonymous> (src/a.test.js:13:13)', "+   why: 'client settings unreadable'", 'expected: "the default value"', '2026-11-22T17:58:09Z started', 'version 24.15.0 of node', "- 'x86_64-apple-darwin'"]) {
    assert.strictEqual(screenLine(line), line);
  }
});

test('the look at other tags is bounded: a far-off line of the same tag is not this failure\'s', () => {
  const lines = ['[a] AssertionError: one', "[a] + 'near-value'", ...Array.from({length: 5000}, (_, i) => `[t${i}] noise`), "[a] + 'from-a-much-later'"];
  const b = run(lines).details.blocks[0];
  assert.ok(!b.values.join('').includes('later'), b.values.join(' / '));
  assert.strictEqual(b.cut, true);
});

test('a block stops at the next test\'s header, in each runner\'s form', () => {
  const py = run(['E       ValueError: first', 'tests/a.py:3: ValueError', '_____ test_b _____', 'def test_b():', '>   g()']);
  assert.ok(!valuesOf(py).join('').includes('test_b'), valuesOf(py).join(' / '));
  const jest = run(['    expect(received).toBe(expected)', '    Expected: 1', 'PASS src/ok.test.js', 'console output of the next file']);
  assert.ok(!valuesOf(jest).join('').includes('next file'), valuesOf(jest).join(' / '));
  const unit = run(['AssertionError: one', "+ 'x-one'", '======================================', 'FAIL: test_two (a.T)', "- 'y-two'"]);
  assert.ok(!valuesOf(unit).join('').includes('y-two'), valuesOf(unit).join(' / '));
});

test('a second failed assertion keeps its own values', () => {
  const d = run(['Error: Expected 1 to equal 2', "+ 'one-value'", 'Error: Expected 3 to equal 4', "+ 'two-value'"]).details;
  assert.strictEqual(d.blocks.length, 2, JSON.stringify(d));
  assert.ok(d.blocks[0].values.join('').includes('one-value') && !d.blocks[0].values.join('').includes('two-value'));
  assert.ok(d.blocks[1].values.join('').includes('two-value'));
});

test('the per-call character bound counts the verdicts too', () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push(`AssertionError: ${'word '.repeat(96)}${i}`, "+ 'a-value'", '', '');
  const d = run(many, 200).details;
  const total = d.blocks.reduce((n, b) => n + b.verdict.length + b.values.join('').length, 0);
  assert.ok(total <= BOUNDS.ALL_CHARS, `${total}`);
  assert.ok(d.omittedBlocks > 0);
});

// The second medium.
test('a bracket that is a value or a timestamp is no runner tag', () => {
  const arrays = valuesOf(run(['AssertionError: arrays differ', '[1, 2, 3]', '[1, 2, 4]']));
  assert.deepStrictEqual(arrays, ['[1, 2, 3]', '[1, 2, 4]']);
  const stamped = valuesOf(run(['[10:00:01] AssertionError: expected 1 to equal 2', '[10:00:02] + expected-value', '[10:00:03] - actual-value'])).join(' ');
  assert.ok(stamped.includes('expected-value') && stamped.includes('actual-value'), stamped);
});

test('a value joined by separators is judged as one', () => {
  for (const v of [CARD16.join('-'), CARD16.join(' '), 'AB12-CD34-EF56-GH78', 'xkqz-pwmv-trbn-hjfd', 'aB3xY:9kLmP:Q2wEr', 'x9QaB=7kLmN', '3f:a9:1c:7e:88:0b:d2:44:19:ce:6a:50:bb:12:9f:73']) {
    const out = screenLine(`+ ${v}`);
    assert.ok(out.includes(WITHHELD) && !out.includes(v), `${v} -> ${out}`);
  }
});

test('a piece is withheld where it is, not where its letters first appear', () => {
  const out = screenBlock(["prefix_x9Q = 'x9Q'", "'7kL'", "'m2P'", "'Zr8'"]);
  assert.ok(!out[0].includes("'x9Q'"), out[0]);
});

test('pieces of any case are joined, and a run of numbered names is not a split value', () => {
  for (const pieces of [["'xkq' +", "'zpw' +", "'mvt' +", "'hjd'"], ['xkq', 'zpw', 'mvt', 'hjd']]) {
    assert.ok(!screenBlock(pieces).join(' ').includes('zpw'), pieces.join(' '));
  }
  const digits = screenBlock(["  '12' + '34' + '56' + '78' + '12' + '34' + '56' + '78'"]).join('');
  assert.ok(!digits.includes("'56'"), digits);
  for (const list of [['+ user1', '+ user2', '- user3'], Array.from({length: 12}, (_, i) => `+ line${i}`), ['+ red', '+ green', '- blue']]) {
    assert.deepStrictEqual(screenBlock(list), list);
  }
});

test('a block keeps text of its own failure that looks like a boundary', () => {
  const testify = ['=== RUN   TestX', '    a_test.go:9:', '        \tError Trace:\t/w/a_test.go:9', '        \tError:      \tNot equal:', '        \t            \texpected: "aaa"', '        \t            \tactual  : "bbb"',
    '        \t            \tDiff:', '        \t            \t--- Expected', '        \t            \t+++ Actual', '        \t            \t-aaa', '        \t            \t+bbb', '        \tTest:       \tTestX', '--- FAIL: TestX (0.00s)'];
  const v = shown(run(testify));
  assert.ok(v.includes('--- Expected') && v.includes('-aaa') && v.includes('+bbb'), v);
  // (these two lines classify as errors, so they reach the answer through `lines`)
  const text = shown(run(['AssertionError: wrong message', '+ "AssertionError: boom"', '- "TypeError: boom"']));
  assert.ok(text.includes('boom') && text.includes('TypeError'), text);
  const list = valuesOf(run(['AssertionError: list differs', '1) first', '2) second'])).join(' ');
  assert.ok(list.includes('first') && list.includes('second'), list);
});

test('ordinary numbers, names and Windows paths stay readable', () => {
  for (const line of ['expected 1.0000000000000002 to equal 1', '+ 0.30000000000000004', 's3Upload.test.js:12', 'src/oauth2Client.test.js:42:13', '+ http2Server', '+ 0x7fff',
    'D:\\a\\repo\\x64\\Release\\foo.test.js:12', 'C:\\build\\123\\foo.test.js:9']) {
    assert.strictEqual(screenLine(line), line);
  }
});

test('a verdict cut at the bound says so, with its placeholder whole', () => {
  const b = run([`AssertionError: ${'word '.repeat(98)}aB3dE9xK2m`, '+ one']).details.blocks[0];
  assert.strictEqual(b.cut, true);
  assert.ok(!/<[a-z]*\u2026$/.test(b.verdict), b.verdict.slice(-20));
});

// Long values, and the bounds and `cut` as they are said.
test('a decimal is a number only at a number\'s length', () => {
  for (const v of [`${CARD16.join('')}.00`, `${CARD15.join('')}.00`, `${'123456789'.repeat(4)}.5`, `1.${'123456789'.repeat(3)}`, `0.5e${'1234567'.repeat(3)}`]) {
    const out = screenLine(`actual: ${v}`);
    assert.ok(out.includes(WITHHELD) && !out.includes(v), `${v} -> ${out}`);
  }
  for (const v of ['0.30000000000000004', '1.0000000000000002', '1700000000.123456', '-12.5', '1.5e-10', '0.00000000000000000001']) {
    assert.strictEqual(screenLine(`actual: ${v}`), `actual: ${v}`);
  }
});

test('a card number is withheld whatever separates its groups', () => {
  const groups = [CARD16, CARD15];
  for (const g of groups) {
    for (const sep of [' ', '  ', '\t', ':', '=', ',', ', ', '/', '.', '-', '_', '|', ';']) {
      const v = g.join(sep);
      const out = screenLine(`+ ${v} end`);
      assert.ok(!out.includes(g[1]) && out.includes(WITHHELD), `${JSON.stringify(v)} -> ${out}`);
    }
  }
  // (four numbers that are no card)
  for (const line of ['+ [1024, 2048, 4096, 8192]', '+ 2026-11-22 17:58:09', '+ [2021,2022,2023,2024]', '+ 1024:2048:4096:8192']) assert.strictEqual(screenLine(line), line);
});

test('a long generated value in short groups is judged as one', () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const word = (n) => Array.from({length: n}, () => letters[Math.floor(next() * 26)]).join('');
  const fixed = ['kqzpa:bhewu:rtyui:mnopa:xleki:vuzba', 'kqzpa_bhewu_rtyui_mnopa_xleki_vuzba', 'kqzpa bhewu rtyui mnopa xleki vuzba', 'kqzpa/bhewu/rtyui/mnopa/xleki/vuzba'];
  for (const v of fixed) {
    const out = screenLine(`+ some words ${v} more words`);
    assert.ok(!out.includes('rtyui') && out.includes(WITHHELD), `${v} -> ${out}`);
  }
  let shown = 0;
  let total = 0;
  for (let round = 0; round < 60; round++) {
    const fingerprint = hex(20).match(/.{4}/g);
    const pairs = hex(20).match(/.{2}/g);
    const mix = Array.from({length: 8}, () => mixed(6).slice(0, 4));
    for (const g of [fingerprint, pairs, mix, Array.from({length: 7}, () => word(5)), Array.from({length: 9}, () => word(4))]) {
      for (const sep of [' ', ':', '-', '_']) {
        total++;
        const out = screenLine(`the value is ${g.join(sep)} here`);
        if (out.includes(g.slice(2, 5).join(sep))) shown++;
      }
    }
  }
  assert.ok(shown / total <= 0.01, `${shown} of ${total} shown`);
  for (const line of ['+ it is not at all the same one as the last run of it', 'a joiner between two letters is kept as it was in it', '+ the_shim_follows_daemon_json_to_a_lock', 'packages/a/src/lib/core/test/unit/db/x.js:12:3',
    '- node-20-on-github-actions-runners', '+ 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16', 'took 10ms 12ms 14ms 18ms 20ms 22ms 31ms 40ms', '+ [100, 200, 300, 400, 500, 600, 700, 800]', 'D:\\a\\repo\\src\\lib\\core\\test\\unit\\db\\x.js', 'user1, user2, user3, user4, user5, user6',
    'MODULE_NOT_IN_THE_POOL_AT_ALL_YET']) {
    assert.strictEqual(screenLine(line), line);
  }
});

test('a line or a verdict the log had already cut says so, though screening took its mark', () => {
  // (a hidden character withholds the whole line, the mark with it)
  const hidden = String.fromCharCode(0x200b);
  const at500 = (head) => `${head}${'word '.repeat(120)}`;
  const value = run(['AssertionError: one', at500(`+ x${hidden}`), '']).details.blocks[0];
  assert.deepStrictEqual([value.values, value.cut], [[LINE_WITHHELD], true]);
  const marked = run(['AssertionError: one', `+ x${hidden} some\u2026`, '']).details.blocks[0];
  assert.strictEqual(marked.cut, true);
  const verdict = run([at500(`AssertionError: x${hidden}`), '+ one', '']).details.blocks[0];
  assert.deepStrictEqual([verdict.verdict, verdict.cut], [LINE_WITHHELD, true]);
  assert.strictEqual(run(['AssertionError: \u2026', '+ one', '']).details.blocks[0].cut, true);
  assert.strictEqual(run(['AssertionError: two', '+ one', '']).details.blocks[0].cut, false);
});

test('the bounds count the verdicts: in characters per failure, in lines per call', () => {
  const many = [];
  for (let i = 0; i < 45; i++) many.push(`AssertionError: number ${i}`, '+ one', '', '');
  const d = run(many, 200).details;
  assert.ok(d.blocks.reduce((n, b) => n + 1 + b.values.length, 0) <= BOUNDS.ALL_LINES, `${d.blocks.length} blocks`);
  assert.strictEqual(d.blocks.length + d.omittedBlocks, 45);
  const b = run([`AssertionError: ${'word '.repeat(90)}`, ...Array.from({length: 8}, (_, i) => `+ ${'word '.repeat(45)}${i}`)]).details.blocks[0];
  assert.ok(b.verdict.length + b.values.join('').length <= BOUNDS.PER_CHARS, `${b.verdict.length + b.values.join('').length}`);
  assert.strictEqual(b.cut, true);
});

test('what one screen hides is never shown because another cut it into parts', () => {
  for (const v of [[...CARD16, '9999', '8888', '7777', '666'].join('-'), ['1234567', ...CARD16, '987654321012345'].join('-'), 'cks-ks-cfrnzvb_jag_wog_wwog_wogzvb_ee_dx-pogzv_______x-p-pth']) {
    assert.strictEqual(screenLine(`+ ${v}`), `+ ${WITHHELD}`, v);
  }
});

test('a long value in groups of any short length, letters and digits mixed, any separator', () => {
  const pool = (chars) => (n) => Array.from({length: n}, () => chars[Math.floor(next() * chars.length)]).join('');
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const base62 = pool(`${lower}${lower.toUpperCase()}0123456789`);
  const base32 = pool(`${lower.toUpperCase()}234567`);
  for (const v of ['kQ-7z-Pa-x9-Rt-yU-mN-0p-Xl-eK-iV-uZ-bA-qW-xZ-jK-vQ', 'kq:zp:ab:xw:rt:yu:mn:op:xl:ek:iv:uz:ba:qw:xz:jk:vq', 'kqz12:bhw34:rty56:mnp78:xlk90:vzb11:qwx22', 'kqz12 bhw34 rty56 mnp78 xlk90 vzb11 qwx22',
    'kqzpa::bhewu::rtyui::mnopa::xleki::vuzba', 'kqzpa+bhewu+rtyui+mnopa+xleki+vuzba', 'kqzpa - bhewu - rtyui - mnopa - xleki - vuzba', '"kqzpa", "bhewu", "rtyui", "mnopa", "xleki", "vuzba"']) {
    const out = screenLine(`+ ${v}`);
    const middle = v.match(/[A-Za-z0-9]+/g).slice(1, -1);
    assert.ok(out.includes(WITHHELD) && !middle.some((g) => out.includes(g)), `${v} -> ${out}`);
  }
  const kinds = [['base62 in twos', () => base62(48).match(/.{2}/g)], ['base62 in threes', () => base62(36).match(/.{3}/g)], ['base32 in fours', () => base32(32).match(/.{4}/g)], ['base62 in ones', () => base62(40).match(/./g)]];
  for (const [why, make] of kinds) {
    let shown = 0;
    for (let round = 0; round < 60; round++) {
      for (const sep of [' ', ':', '-']) {
        const v = make().join(sep);
        if (screenLine(`+ ${v}`).includes(v)) shown++;
      }
    }
    assert.ok(shown <= 2, `${why}: ${shown} of 180 shown whole`);
  }
  for (const g of [CARD16, CARD15]) {
    for (const v of [g.join('\\'), g.map((x) => `"${x}"`).join(','), `${g[0]}  ${g[1]} ${g.slice(2).join('  ')}`]) assert.ok(!screenLine(`+ ${v}`).includes(g[1]), v);
  }
  for (const line of ['v1 v2 v3 v4 v5 v6 v7 v8 v9 v10 v11 v12', '+ {"id":1,"ok":true,"to":"a user","of":["one","two"]}', '+ [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]', "+   at: 'the end', by: 'me', to: 'you', in: 'a day'"]) assert.strictEqual(screenLine(line), line);
});

test('a long value over many lines, one short group on each', () => {
  const out = screenBlock(['+ kqzpa', '+ bhewu', '+ rtyui', '+ mnopa', '+ xleki', '+ vuzba', '+ kuxot']).join(' ');
  assert.ok(!out.includes('rtyui') && !out.includes('mnopa'), out);
  const words = ['+ red', '+ green', '+ blue', '+ white', '+ black', '+ pink', '+ grey', '+ brown', '+ gold'];
  assert.deepStrictEqual(screenBlock(words), words);
});

// node's own shapes: values after the frames (spec), and the TAP diagnostic.
const FRAMES = ['      at TestContext.<anonymous> (/w/a.test.js:5:32)', '      at Test.runInAsyncScope (node:async_hooks:227:14)', '      at Test.run (node:internal/test_runner/test:1201:25)'];
const spec = (message, props) => ['✖ compares (0.5ms)', `  AssertionError [ERR_ASSERTION]: ${message}`, ...FRAMES.slice(0, 2), `${FRAMES[2]} {`, '    generatedMessage: false,', "    code: 'ERR_ASSERTION',", ...props, "    diff: 'simple'", '  }', ''];
test('an assertion with a message only: its actual and expected come from the properties after the frames', () => {
  const b = run(spec('the line matches', ["    actual: 'beta-actual',", '    expected: /alpha-expected/,', "    operator: 'match',"])).details.blocks[0];
  assert.deepStrictEqual(b.values.map((v) => v.trim()), ['at TestContext.<anonymous> (/w/a.test.js:5:32)', "actual: 'beta-actual',", 'expected: /alpha-expected/,']);
  assert.strictEqual(b.cut, false);
  // a value over lines, whole; a key inside it is not one of the block's
  const deep = run(spec('alike', ['    actual: {', "      code: 'inner',", '      list: [', "        'beta-actual'", '      ]', '    },', "    expected: 'one\\n' +", "      'alpha-expected',", "    operator: 'partialDeepStrictEqual',"])).details.blocks[0];
  const v = deep.values.join('\n');
  assert.ok(v.includes('beta-actual') && v.includes('alpha-expected') && v.includes("code: 'inner'") && !v.includes('operator') && !v.includes('ERR_ASSERTION'), v);
});

test('the properties after the frames are screened, bounded, and left alone when the diff came first', () => {
  const secret = mixed(24);
  const b = run(spec('the key', [`    actual: '${secret}',`, "    expected: 'alpha-expected',", "    operator: 'match',"])).details.blocks[0];
  absent(b.values, secret, 'a property');
  const long = run(spec('long', ['    actual: [', ...Array.from({length: 20}, (_, i) => `      'item ${i}',`), '    ],', "    operator: 'match',"])).details.blocks[0];
  assert.ok(long.values.length <= BOUNDS.PER_LINES && long.cut === true, JSON.stringify(long));
  const diff = run(['✖ compares', '  AssertionError [ERR_ASSERTION]: the code is as expected', '  ', "  'beta-actual' !== 'alpha-expected'", '  ', ...spec('x', ["    actual: 'prop-actual',", "    expected: 'prop-expected',"]).slice(2)]);
  assert.ok(both(diff) && !valuesOf(diff).join('').includes('prop-'), valuesOf(diff).join('\n'));
  // assert.ok: expected true says nothing
  const ok = valuesOf(run(spec('it holds', ['    actual: false,', '    expected: true,', "    operator: '==',"]))).join('\n');
  assert.ok(!ok.includes('expected: true'), ok);
  // the properties of the next failure are not this one's
  const two = run(['  AssertionError [ERR_ASSERTION]: one', ...FRAMES, '', '  AssertionError [ERR_ASSERTION]: two', ...spec('x', ["    actual: 'beta-actual',"]).slice(2)]).details.blocks;
  assert.deepStrictEqual(two.map((x) => [x.verdict.trim(), x.values.map((v) => v.trim())]), [['AssertionError [ERR_ASSERTION]: two', ['at TestContext.<anonymous> (/w/a.test.js:5:32)', "actual: 'beta-actual',"]]]);
});

const tap = (n, name, body, pad = '') => [`# Subtest: ${name}`, `not ok ${n} - ${name}`, '  ---', '  duration_ms: 0.9', "  type: 'test'", `  location: '/w/a.test.js:${n}:1'`, "  failureType: 'testCodeFailure'", ...body, '  stack: |-', `    TestContext.<anonymous> (/w/a.test.js:${n}:32)`, '    Test.runInAsyncScope (node:async_hooks:214:14)', '    Test.run (node:internal/test_runner/test:1047:25)', '  ...'].map((l) => pad + l);
const tapEnd = ["  code: 'ERR_ASSERTION'", "  name: 'AssertionError'"];
const STRICT = ['  error: |-', '    the code is as expected', '    ', "    'beta-actual' !== 'alpha-expected'", '    ', ...tapEnd, "  expected: 'alpha-expected'", "  actual: 'beta-actual'", "  operator: 'strictEqual'"];
const MATCH = ["  error: 'the line matches'", ...tapEnd, '  expected:', "  actual: 'beta-actual'", "  operator: 'match'"];
const DEEP = ['  error: |-', '    Expected values to be strictly deep-equal:', '    + actual - expected', '    ', '      {', "    +   v: 'beta-actual'", "    -   v: 'alpha-expected'", '      }', '    ', ...tapEnd, '  expected:', "    v: 'alpha-expected'", '    list:', '      0: 1', '  actual:', "    v: 'beta-actual'", '    list:', '      0: 1', "  operator: 'deepStrictEqual'"];
test('TAP: the message, the values and the location, and nothing else of the diagnostic', () => {
  for (const pad of ['', '    ', '[a.test.js] ']) {
    const strict = run(tap(1, 'strict', STRICT, pad));
    assert.ok(both(strict), JSON.stringify(strict.details));
    const match = run(tap(2, 'match', MATCH, pad));
    assert.ok(shown(match).includes('beta-actual') && shown(match).includes('the line matches'), JSON.stringify(match.details));
    const deep = run(tap(3, 'deep', DEEP, pad));
    const v = valuesOf(deep).join('\n');
    assert.ok(v.includes("+   v: 'beta-actual'") && v.includes("-   v: 'alpha-expected'"), v);
    assert.ok(!v.includes('list:'), `the diff has them already: ${v}`);
    for (const out of [strict, match, deep]) {
      const text = valuesOf(out).join('\n');
      assert.ok(/\/w\/a\.test\.js:\d:32/.test(text), `the location: ${text}`);
      assert.ok(!/operator|duration_ms|node:internal|async_hooks|failureType/.test(text), text);
      assert.strictEqual(out.details.blocks.length, 1, JSON.stringify(out.details));
      assert.strictEqual(out.details.blocks[0].cut, false);
    }
  }
});

test('TAP: many failures each keep their values, and each block has its own verdict', () => {
  const lines = [1, 2, 3, 4, 5, 6].flatMap((n) => tap(n, `test number ${n}`, STRICT.map((l) => l.replace('beta-actual', `beta-actual-${n}`))));
  const d = run(lines, 200).details;
  assert.strictEqual(d.blocks.length, 6, JSON.stringify(d));
  d.blocks.forEach((b, k) => assert.deepStrictEqual(b.values.map((v) => v.trim()).slice(1), [`'beta-actual-${k + 1}' !== 'alpha-expected'`, `TestContext.<anonymous> (/w/a.test.js:${k + 1}:32)`], JSON.stringify(b)));
  assert.strictEqual(new Set(d.blocks.map((b) => b.index)).size, 6);
});

test('TAP: a passing or TODO test, an ok with a diagnostic, and an unclosed one', () => {
  const todo = run(['not ok 1 - later # TODO not yet', ...tap(1, 'x', MATCH).slice(2)]);
  assert.ok(!valuesOf(todo).join('').includes('beta-actual'), JSON.stringify(todo.details));
  const passed = run(['ok 1 - fine', '  ---', '  duration_ms: 1', '  ...', ...tap(2, 'match', MATCH)]);
  assert.ok(shown(passed).includes('beta-actual'));
  // (the log ends inside its values: they are kept, and said to go on)
  const lines = tap(1, 'cut off', DEEP);
  const open = extractErrors([{name: 'Run tests', lines: [...Array.from({length: 20}, () => 'more output'), ...lines.slice(0, lines.findIndex((l) => l.trim() === 'actual:') + 2)]}], 40);
  assert.strictEqual(open.details.blocks.length, 1, JSON.stringify(open.details));
  assert.strictEqual(open.details.blocks[0].cut, true);
  assert.ok(valuesOf(open).join('\n').includes("+   v: 'beta-actual'"), JSON.stringify(open.details));
  const held = run(tap(1, 'it holds', ["  error: 'it holds'", ...tapEnd, '  expected: true', '  actual: false', "  operator: '=='"]));
  assert.ok(!valuesOf(held).join('').includes('expected: true'));
});

test('a block has all its lines, and the place of each that is in `lines` too', () => {
  const out = run(['  ● suite › compares', '    expect(received).toBe(expected) // Object.is equality', '    Expected: "alpha-expected"', '    Received: "beta-actual"', '    extra text', '      at Object.<anonymous> (src/a.test.js:13:13)']);
  const b = out.details.blocks[0];
  const text = b.values.join('\n');
  assert.ok(text.includes('alpha-expected') && text.includes('beta-actual') && text.includes('a.test.js:13:13'), text);
  assert.deepStrictEqual(b.places, b.values.map((v) => out.lines.findIndex((l) => l.text === v)));
  assert.ok(b.places.some((k) => k >= 0) && b.places.includes(-1), JSON.stringify(b));
  // a line of `lines` is screened here all the same
  const secret = mixed(24);
  absent(run(['    expect(received).toBe(expected)', `    Expected: "${secret}"`, '    Received: "x"']).details.blocks[0].values, secret, 'a kept line');
  // a failure with all its lines in `lines` has its block too
  const all = run(['    expect(received).toBe(expected)', '    Expected: 1', '    Received: 2']).details.blocks[0];
  assert.deepStrictEqual(all.values.map((v) => v.trim()), ['Expected: 1', 'Received: 2']);
  assert.ok(all.places.every((k) => k >= 0), JSON.stringify(all));
  // (JSON that `lines` cuts at 200 characters is not there whole)
  const json = (last) => JSON.stringify({...Object.fromEntries(Array.from({length: 14}, (_, i) => [`property${i}`, 'some text'])), last});
  const long = run(['    expect(received).toEqual(expected)', `    Expected: ${json(1)}`, `    Received: ${json(9)}`]);
  assert.deepStrictEqual(long.details.blocks[0].places, [-1, -1], JSON.stringify(long));
  assert.ok(long.details.blocks[0].values[1].includes('"last":9'));
});

test('a block says which of `lines` is its verdict, and that its record is repeated', () => {
  const out = run(['noise Error: one', ...SHAPES['node assert under mocha']]);
  const b = out.details.blocks[0];
  assert.ok(Number.isInteger(b.line) && out.lines[b.line].text.includes('AssertionError') && out.lines[b.line].index === b.index, JSON.stringify(out));
  assert.ok(!('repeats' in b));
  // (two steps of one name: the place, not the step and the index, tells them apart)
  const same = extractErrors([{name: 'Run tests', lines: ['Error: x', '##[error]Process completed with exit code 1.']}, {name: 'Run tests', lines: ['AssertionError: y', "+ 'beta-actual'", ...AFTER, EXIT]}], 40);
  assert.ok(same.lines[same.details.blocks[0].line].text.includes('AssertionError'), JSON.stringify(same));
  const left = run(SHAPES['node assert under mocha'], 1).details.blocks[0];
  assert.ok(!('line' in left), JSON.stringify(left));
  const record = (id) => JSON.stringify({level: 50, time: 1700000000000 + id, pid: 10 + id, msg: 'AssertionError: the same'});
  const again = run([record(1), "+ 'beta-actual'", 'more', '', '', record(2), "+ 'other-actual'"]);
  const twice = again.lines.find((l) => l.repeats === 2);
  assert.ok(twice !== undefined, JSON.stringify(again));
  assert.strictEqual(again.details.blocks[0].repeats, 2, JSON.stringify(again));
});

// The high review: long values with punctuation, long digits, a value at the cut.
const alphabet = (chars) => (n) => Array.from({length: n}, () => chars[Math.floor(next() * chars.length)]).join('');
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const longest = (value, out) => {
  let best = 0;
  for (let i = 0; i < value.length; i++) while (i + best < value.length && out.includes(value.slice(i, i + best + 1))) best++;
  return best;
};
test('a long generated value with punctuation is withheld, wherever it sits', () => {
  const ascii = alphabet(Array.from({length: 94}, (_, i) => String.fromCharCode(33 + i)).join(''));
  const django = alphabet(`${LETTERS}${DIGITS}!@#$%^&*(-_=+)`);
  for (const [why, make, n, whole, part] of [['ascii', ascii, 24, 0.03, 0.1], ['ascii', ascii, 40, 0, 0.05], ['django', django, 24, 0.05, 0.1], ['django', django, 50, 0, 0.03]]) {
    let shownWhole = 0;
    let shownPart = 0;
    for (let round = 0; round < 100; round++) {
      const v = make(n);
      const out = screenLine([`+ ${v}`, `- '${v}'`, `+   value: "${v}",`, `+ got ${v} back`][round % 4]);
      if (out.includes(v)) shownWhole++;
      if (longest(v, out) >= 12) shownPart++;
    }
    assert.ok(shownWhole <= whole * 100 && shownPart <= part * 100, `${why} ${n}: whole ${shownWhole}, 12 in a row ${shownPart}, of 100`);
  }
  for (const line of ['+ this.items[i].count===0&&other>=limit', '+ {"code":"MODULE_NOT_LISTED","retryable":false,"why":"unset"}', 'expect(received).toBe(expected)', 'https://example.invalid/docs/settings?tab=limits&view=all', "+ '@countinghouse/ch-step-redact/lib/rules.js'", 'D:\\a\\repo\\test\\client-conditions.test.js:336:10',
    '+ --moduleSandbox=enforce --maxRequestBody=1mb', '+ 2026-11-22T17:58:09.123Z', '- {"a":1,"b":2,"c":3,"d":4,"e":5}', '+ <Buffer 01 02>', '+ ${HOME}/.config/app/settings.json', "require('../lib/errors').catalogue['MODULE_LOAD_FAILED']"]) {
    assert.strictEqual(screenLine(line), line);
  }
});

test('long digits in groups are withheld whole, whatever separates them; so is a key as a list of bytes', () => {
  const digits = alphabet(DIGITS);
  const seps = [' ', '  ', '\t', ':', '=', ',', ', ', '/', '.', '-', '_', '|', '\\', ';'];
  for (const sep of seps) {
    for (const widths of [[7, 4, 4, 4, 4, 15], [5, 5, 5, 5, 5, 5, 5, 5], [8, 8, 8, 8, 8], [4, 4, 4, 4, 4, 4]]) {
      const g = widths.map(digits);
      const out = screenLine(`+ '${g.join(sep)}' end`);
      assert.ok(!g.some((x) => out.includes(x)), `${JSON.stringify(sep)} ${widths}: ${out}`);
    }
  }
  const list = (n) => Array.from({length: n}, () => Math.floor(next() * 256));
  for (const sep of [', ', ',', ' ']) {
    const b = list(32);
    const out = screenLine(`+ [${b.join(sep)}]`);
    assert.ok(out.includes(WITHHELD) && !out.includes(b.slice(3, 8).join(sep)), out);
  }
  const b = list(32);
  const lines = [0, 1, 2, 3].map((k) => `+   ${b.slice(k * 8, k * 8 + 8).join(', ')},`);
  assert.ok(!screenBlock(['+ [', ...lines, '+ ]']).join(' ').includes(b.slice(9, 13).join(', ')), 'over lines');
  for (const line of ['+ [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116]', '+ [1700000000000, 1700000000100, 1700000000200]', '+ [0, 1, 0, 0, 2, 1, 0, 3, 0, 1, 1, 0, 0, 2, 0, 1, 0]', '+ 1024, 2048, 4096, 8192, 9000, 9100, 9200, 9300']) assert.strictEqual(screenLine(line), line);
});

test('a path hides no joined value in a segment', () => {
  for (const v of [`src/${CARD16.join('-')}/x.js`, 'C:\\tmp\\AB12-CD34-EF56-GH78\\x.js', 'lib/xkqz-pwmv-trbn-hjfd/x.js']) {
    const out = screenLine(`+ ${v}`);
    assert.ok(out.includes(WITHHELD) && ![CARD16.slice(1, 3).join('-'), 'CD34-EF56', 'pwmv-trbn'].some((x) => out.includes(x)), out);
  }
});

test('a value at the line cut: the whole stretch goes, and the short groups before it', () => {
  for (const [head, v] of [['some words and then ', 'partOf!AVal.x'], ['the key ', 'xkqz pwmv trbn hjfd'], ['number ', CARD16.slice(0, 3).join(' ')], ['key ', 'aB3d-eF7h-iJ1k']]) {
    const out = screenLine(`+ ${head}${v}\u2026`);
    assert.ok(out.startsWith(`+ ${head.split(' ')[0]}`) && out.endsWith(`${WITHHELD}\u2026`), out);
    for (const part of v.split(/[ .!-]/)) assert.ok(part.length < 3 || !out.includes(part), `${v} -> ${out}`);
  }
});

test('a placeholder is never cut into by another', () => {
  for (const lines of [['+ aB3dE9xK2m7Q', '- thh', '+ xkq'], ['+ aB3dE9xK2m7Q', '- e', '+ h'], ["  'w' + 'x9Q' + 'held' + '7kL' + 'aB3dE9xK2m7Q4r'"], ['+ xkq', '- zpw', '+ e', '- ld']]) {
    for (const out of screenBlock(lines)) assert.ok(!/<(?!withheld>|value line withheld>)/.test(out) && !/(?<!<withheld|<value line withheld)>/.test(out), out);
  }
});

// Where a block ends. log-clean drops blank lines, so none is there to end it.
const noBlanks = (lines) => lines.filter((l) => l.trim() !== '');
test('a block ends at the first line that is no value, with no blank line to say so', () => {
  const next = ['Run the build', 'compiled 12 files', 'done: 3 warnings'];
  for (const lines of [['AssertionError: one', "+ 'beta-actual'", "- 'alpha-expected'"], SHAPES.pytest, SHAPES.rust, SHAPES['node assert under mocha'].slice(0, -1), ['AssertionError: lists differ', 'First differing element 0:', "'beta-actual'", "'alpha-expected'", '- [1]', '+ [2]']]) {
    const out = run(noBlanks([...lines, ...next]));
    assert.ok(both(out), JSON.stringify(out.details));
    assert.ok(!/compiled|build|warnings/.test(valuesOf(out).join('\n')), valuesOf(out).join('\n'));
  }
  for (const lines of Object.values(SHAPES)) assert.ok(both(run(noBlanks(lines))), JSON.stringify(lines));
  // a value over lines, at the left edge, stays whole
  const object = valuesOf(run(noBlanks(['AssertionError: objects differ', '{', 'name: "beta-actual",', 'list: [', '1,', '],', '}', ...next])));
  assert.deepStrictEqual(object, ['{', 'name: "beta-actual",', 'list: [', '1,', '],', '}']);
});

test('what is no failed assertion gives no block: a TAP failure with no values, summaries, lint rows', () => {
  const bare = run(tap(1, 'boom', ["  error: 'boom'", ...tapEnd]).concat(['# Subtest: the next', 'ok 2 - the next']));
  assert.ok(!('details' in bare), JSON.stringify(bare.details));
  const pytest = run(noBlanks([...SHAPES.pytest, '=========================== short test summary info ===========================', "FAILED tests/test_a.py::test_values - AssertionError: assert 'x' == 'y'", '1 failed, 2 passed in 0.12s']));
  assert.strictEqual(pytest.details.blocks.length, 1, JSON.stringify(pytest.details));
  assert.ok(!/FAILED|passed/.test(valuesOf(pytest).join('\n')), valuesOf(pytest).join('\n'));
  const quiet = run(["E       assert 'x' == 'y'", 'FAILED tests/test_a.py::test_b - assert 1 == 2', '1 failed in 0.02s']);
  assert.ok(!/FAILED|1 failed/.test(valuesOf(quiet).join('\n')), JSON.stringify(quiet.details));
  const lint = run(['/w/src/a.js', "  12:5  error  Expected '===' and instead saw '=='  eqeqeq", "  14:5  error  Expected '===' and instead saw '=='  eqeqeq"]);
  assert.ok(!('details' in lint), JSON.stringify(lint.details));
  for (const end of ['# Subtest: next', '# tests 4', 'ℹ tests 4', '  3 passing (5ms)']) {
    const v = valuesOf(run(['AssertionError: one', "+ 'x-value'", end, "- 'not-this'"]));
    assert.deepStrictEqual(v, ["+ 'x-value'"], end);
  }
});

test('a code frame is passed over: the values and the location are kept', () => {
  const frame = ['      10 |   it("compares", () => {', '      11 |     const x = f();', '    > 12 |     expect(x).toBe(1);', '         |               ^', '      13 |   });'];
  const jest = run(noBlanks(['  ● suite › compares', '    expect(received).toBe(expected) // Object.is equality', '    Expected: "alpha-expected"', '    Received: "beta-actual"', ...frame, ...frame, ...frame, '      at Object.<anonymous> (src/a.test.js:12:15)']));
  const v = valuesOf(jest).join('\n');
  assert.ok(v.includes('a.test.js:12:15') && !/ 1[0-3] \|/.test(v), v);
  const vitest = run(noBlanks(['AssertionError: expected 1 to be 2 // Object.is equality', '- Expected', '+ Received', '- "alpha-expected"', '+ "beta-actual"', ' ❯ src/a.test.ts:12:15', '     10|   it("compares", () => {', '     12|     expect(x).toBe(1);', '       |               ^']));
  assert.ok(both(vitest) && !/ 1[02]\|/.test(valuesOf(vitest).join('\n')), valuesOf(vitest).join('\n'));
  const table = valuesOf(run(['AssertionError: tables differ', '+ | a | b |', '- | a | c |']));
  assert.deepStrictEqual(table, ['+ | a | b |', '- | a | c |']);
});

test('the look at a log is bounded: each line is read once, and only so many in all', () => {
  const {valueBlocks} = require('../lib/values');
  const n = 8000;
  for (const line of [(i) => `[t${i}] AssertionError: x`, () => 'AssertionError: x', (i) => (i % 2 ? '  ---' : 'not ok 1 - x'), (i) => (i % 2 ? '    at f (a.js:1:1)' : 'AssertionError: x')]) {
    const texts = Array.from({length: n}, (_, i) => line(i));
    let tags = 0;
    let bodies = 0;
    const tagOf = (text) => { tags++; return (/^\[\w+\]/.exec(text) || [''])[0]; };
    const bodyOf = (text) => { bodies++; return text.replace(/^\[\w+\] /, ''); };
    valueBlocks({texts, kinds: texts.map((x) => (x.includes('Assertion') ? 'assert' : null)), skipped: texts.map(() => false), placeOf: () => -1, isWhole: () => true, repeatsOf: () => 1, tagOf, bodyOf, step: 's', cut: (x) => x});
    assert.ok(tags <= n && bodies <= n, `${line(0)}: ${tags} tags, ${bodies} bodies for ${n} lines`);
  }
});

// The second high read.
test('a hex dump is judged as one value: its halves are two blanks apart', () => {
  for (let round = 0; round < 40; round++) {
    const b = bytes(16);
    const pairs = [...b].map((x) => x.toString(16).padStart(2, '0'));
    const gutter = [...b].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    for (const line of [`- 00000000  ${pairs.slice(0, 8).join(' ')}  ${pairs.slice(8).join(' ')}  |${gutter}|`, `+ ${pairs.slice(0, 8).join(' ')}   ${pairs.slice(8).join(' ')}`]) {
      const out = screenLine(line);
      assert.ok(!out.includes(pairs.slice(0, 8).join(' ')) && !out.includes(pairs.slice(8).join(' ')), out);
    }
  }
  for (const line of ['-rw-r--r--  1 runner docker   120 Nov 22 10:00 out.log', 'Tests:       1 failed, 12 passed, 13 total', '  12:5   error  Expected indentation of 2 spaces  indent', 'name      status   age', 'a  b  c  d  e  f  g  h', '1  2  3  4  5  6  7  8  9  10  11  12  13  14  15  16']) assert.strictEqual(screenLine(line), line);
});

test('a key as signed bytes, and one after a count, is withheld; ordinary signed lists are not', () => {
  for (let round = 0; round < 40; round++) {
    const signed = Array.from({length: 32}, () => Math.floor(next() * 256) - 128);
    const unsigned = Array.from({length: 32}, () => Math.floor(next() * 256));
    for (const sep of [', ', ',', ' ']) {
      assert.ok(!screenLine(`+ [${signed.join(sep)}]`).includes(signed.slice(0, 20).join(sep)), signed.join(sep));
      for (const line of [`+ key(1024) [${unsigned.join(sep)}]`, `+ key(1024) [${sep.trimStart()}${unsigned.join(sep)} ]`]) assert.ok(!screenLine(line).includes(unsigned.slice(0, 20).join(sep)), line);
    }
  }
  for (const line of ['+ [-1, 0, 1, -1, 0, 1, 0, 0, -1, 1, 2, -2, 0, 1, 0, -1, 1]', '- count(20) [1, 2, 0, 3, 1, 0, 2, 1, 0, 4, 1, 2, 0, 1, 3, 0, 2, 1, 0, 1]', '+ [-100, -90, -80, -70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50]']) assert.strictEqual(screenLine(line), line);
});

test('digits in groups that read as a list are shown: a stated limit', () => {
  for (const line of ['+ 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90', '+ 123 456 789 123 456 789 123 456 789 123', '+ 1,234,567,890,123,456,789,012,345,678']) assert.strictEqual(screenLine(line), line);
});

test('a table\'s numbered rows are values: only a frame with its mark or caret is code', () => {
  const rows = ['+ id | name | age', '  12 | alpha-expected | 30', '  13 | beta-actual | 31'];
  const table = run(noBlanks(['  AssertionError: rows differ', ...rows, '      at f (/w/a.js:1:1)'])).details.blocks[0];
  assert.deepStrictEqual(table.values.map((v) => v.trim()).slice(0, 3), rows.map((r) => r.trim()), JSON.stringify(table));
  assert.strictEqual(table.cut, false);
  const code = run(noBlanks(['  AssertionError: rows differ', '  + 1', '    > 12 |     expect(x).toBe(1);', '      13 |   });', '      at f (/w/a.js:1:1)'])).details.blocks[0];
  assert.ok(!code.values.join('').includes('|'), JSON.stringify(code));
});

test('a Rust panic\'s message is the line after it, whatever it looks like', () => {
  const lines = ["thread 'attach::tests::one' (20091) panicked at src/attach.rs:694:9:", 'Some(GaveUp("20 s (the daemon is starting)"))', 'Compiling the next crate', 'done'];
  const out = run(lines, 1);
  assert.deepStrictEqual(valuesOf(out), [lines[1]], JSON.stringify(out.details));
  const old = run(["thread 'one' panicked at 'assertion failed', src/a.rs:1:2", 'note: run with `RUST_BACKTRACE=1`', 'Compiling the next crate'], 1);
  assert.ok(!('details' in old), JSON.stringify(old.details));
});

test('a long value of hex or digits among marks is withheld: too few letters to judge by words', () => {
  for (const chars of ['0123456789abcdef!@#$%^&*', `${DIGITS}!@#$%^&*`]) {
    const make = alphabet(chars);
    let shownWhole = 0;
    for (let round = 0; round < 100; round++) {
      const v = make(24);
      if (screenLine([`+ ${v}`, `- '${v}'`, `+   value: "${v}",`, `+ got ${v} back`][round % 4]).includes(v)) shownWhole++;
    }
    // (a limit for the test, allowing for random variation, not a measured rate)
    assert.ok(shownWhole <= 5, `${chars}: ${shownWhole} of 100 shown`);
  }
});

test('a bracketed list stays whole', () => {
  for (const line of ['+ [[1,2],[3,4],[5,6]]', '+ (12,34),(56,78),(90,12)', '- <1>,<2>,<3>,<4>,<5>', "+ ['1','2','3','4','5']", '+ src/a.js(12,34)']) assert.strictEqual(screenLine(line), line);
});

test('compact JSON stays whole', () => {
  for (const line of ['+ {"id":12345,"n":[1,2,3]}', '- [{"a":1},{"a":2},{"a":3}]', '+ {"width":1024,"height":768}', '- {"x":1.5,"y":-2.25,"z":0}', '+ {a:1,b:[2,3],c:{d:4}}']) assert.strictEqual(screenLine(line), line);
});

test('a Set or a Map stays whole', () => {
  for (const line of ['+ Set(3){1,2,3}', '- Map(2){1=>2,3=>4}', '+ Set(3) { 1, 2, 3 }', "- Map(2) { 'a' => 1, 'b' => 2 }"]) assert.strictEqual(screenLine(line), line);
});
