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

// (business's choice, 11-28, for lines and details alike: words in any script
// read as words, symbols are kept, and a token mixing letters and digits in a
// script other than ASCII is withheld)
const {screenLine} = require('../lib/values');
const pick = (alphabet, n) => [...crypto.randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('');
const CYRILLIC = '\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044d\u044e\u044f\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u041a\u041b\u041c\u041d\u041e\u041f\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u042d\u042e\u042f';

test('a run of one script\'s letters reads as words: Cyrillic, Chinese, Japanese (kana and kanji together)', () => {
  for (const words of ['\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f \u043a \u0431\u0430\u0437\u0435', '\u6d4b\u8bd5\u5931\u8d25', '\u30c6\u30b9\u30c8\u304c\u5931\u6557\u3057\u307e\u3057\u305f', '\u0394\u03bf\u03ba\u03b9\u03bc\u03ae \u03b1\u03c0\u03ad\u03c4\u03c5\u03c7\u03b5']) {
    assert.strictEqual(screenLine(`Error: ${words}`), `Error: ${words}`, words);
  }
  const out = run(['Error: \u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f \u043a \u0431\u0430\u0437\u0435']);
  assert.ok(out.lines.some((l) => l.text === 'Error: \u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f \u043a \u0431\u0430\u0437\u0435'), JSON.stringify(out.lines));
});

test('a symbol-only token reads: a test runner\'s marks', () => {
  for (const mark of ['\u25cf', '\u2715', '\u2713', '\u00d7', '\u2192']) assert.strictEqual(screenLine(`  ${mark} adds two numbers`), `  ${mark} adds two numbers`, mark);
});

test('a token mixing letters and digits in a script other than ASCII is withheld', () => {
  // (made at run time: Cyrillic letters and digits, interleaved)
  const t = [...pick(CYRILLIC, 8)].map((c, i) => c + String(i % 10)).join('');
  const shown = screenLine(`Error: session ${t} rejected`);
  assert.ok(!shown.includes(t), shown);
  assert.ok(shown.includes(WITHHELD), shown);
});

// (a path segment that looks generated used to be withheld alone, and the
// screen stopped there, so what another segment held passed unjudged: here,
// letters of two scripts in one run, in a token too short for the screen of
// long runs to see)
test('in a path, a segment that looks generated does not stop the screen of the other segments', () => {
  // (two runs of three consonants, no word of code, and a Cyrillic letter
  // with a Greek one, made at run time)
  const CONSONANTS = 'bcdfghjklmnpqrstvwxz';
  const CODE = new Set(['css', 'sql', 'tcp', 'udp', 'tls', 'ssl', 'ssh', 'dns', 'src', 'cmd', 'ctx', 'msg', 'pkg', 'tmp', 'cfg', 'std', 'xml']);
  const three = () => { for (;;) { const t = pick(CONSONANTS, 3); if (!CODE.has(t)) return t; } };
  const seg = `${three()}-${three()}`;
  const mixed = pick(CYRILLIC, 1) + pick('\u03b1\u03b2\u03b3\u03b4\u03b5\u03b6\u03b7\u03b8', 1);
  const shown = screenLine(`x: ${seg}/${mixed}`);
  assert.ok(!shown.includes(seg), shown);
  assert.ok(!shown.includes(mixed), `the other segment withheld too: ${shown}`);
});

// (the medium on the draft) a kept line is judged with the lines next to it
// in the log, never with one far away: a readable line beside 47 lines left
// out is not withheld for a value before them
test('kept lines far apart in the log are screened apart', () => {
  const v = value();
  const lines = ['FAIL src/a.md:12', `  ${v}`, ...Array.from({length: 47}, (_, i) => `progress ${i}`), '  pqrs', ...Array.from({length: 14}, (_, i) => `more ${i}`)];
  const out = run(lines);
  const far = out.lines.find((l) => l.index === 49);
  if (far != null) assert.strictEqual(far.text, '  pqrs', JSON.stringify(out.lines.map((l) => [l.index, l.text])));
  assert.ok(!out.lines.some((l) => l.text.includes(v)));
});

test('punctuation outside ASCII does not break a word\'s reading: a Japanese sentence\'s full stop, guillemets, corner brackets', () => {
  for (const t of ['Error: \u30c6\u30b9\u30c8\u304c\u5931\u6557\u3057\u307e\u3057\u305f\u3002',
    'Error: \u00ab\u041e\u0448\u0438\u0431\u043a\u0430\u00bb',
    '\u300c\u30c6\u30b9\u30c8\u300d failed']) {
    assert.strictEqual(screenLine(t), t, t);
  }
});

test('a path under a home folder in another script keeps its readable parts: the letters-with-digits rule is a segment\'s', () => {
  const t = 'at /home/\u0438\u0432\u0430\u043d/proj/test1.js:5';
  assert.strictEqual(screenLine(t), t);
});


// (business's hardening, 11-28: what reads outside ASCII is bounded, as an
// ASCII run is; every value drawn at run time from its block of code points)
const from = (lo, hi, n) => Array.from({length: n}, () => String.fromCodePoint(lo + (crypto.randomBytes(2).readUInt16BE(0) % (hi - lo + 1)))).join('');
const withheld = (line, part) => { const s = screenLine(line); return !s.includes(part) && s.includes(WITHHELD); };
const kept = (line) => screenLine(line) === line;

test('(a) Latin letters outside ASCII are folded and judged as ASCII words: a random run is withheld, an accented word reads', () => {
  const ext = from(0x100, 0x17f, 26);
  assert.ok(withheld(`token: ${ext}`, ext), 'Latin Extended-A, random');
  const full = Array.from({length: 26}, () => from(0xff21, 0xff3a, 1) + from(0xff41, 0xff5a, 1)).join('').slice(0, 26);
  const shownFull = screenLine(`token: ${full}`);
  assert.ok(!shownFull.includes(full) && shownFull.includes(WITHHELD), 'fullwidth Latin, random');
  assert.ok(kept('Error: café not found'));
  assert.ok(kept('Error: ＴＥＳＴ failed'), 'a fullwidth word reads');
});

test('(b) never read as symbols: Braille, emoji, marks with no letter, private use; a test runner\'s marks still read', () => {
  for (const [what, v] of [['Braille', from(0x2801, 0x28ff, 32)], ['emoji', from(0x1f600, 0x1f64f, 20)],
    ['marks with no letter', from(0x300, 0x36f, 6)], ['private use', from(0xe000, 0xf8ff, 8)]]) {
    const s = screenLine(`dump ${v}`);
    assert.ok(!s.includes(v), `${what}: ${JSON.stringify(s)}`);
  }
  for (const mark of ['●', '✕', '✓', '×', '→', '✔', '✖']) assert.ok(kept(`  ${mark} adds two numbers`), mark);
});

test('(c) an alphabetic script\'s run reads up to 24 letters; 25 is withheld', () => {
  assert.ok(kept(`Error: ${from(0x430, 0x44f, 24)}`), 'Cyrillic, 24');
  const long = from(0x430, 0x44f, 25);
  assert.ok(withheld(`Error: ${long}`, long), 'Cyrillic, 25');
});

test('(d) a Han, kana or Hangul run reads up to 32 characters; 33 is withheld; each split point splits it', () => {
  assert.ok(kept(`Error: ${from(0x4e00, 0x9fff, 32)}`), 'Han, 32');
  const han = from(0x4e00, 0x9fff, 33);
  assert.ok(withheld(`Error: ${han}`, han), 'Han, 33');
  assert.ok(kept(`Error: ${from(0xac00, 0xd7a3, 32)}`), 'Hangul, 32');
  const hangul = from(0xac00, 0xd7a3, 33);
  assert.ok(withheld(`Error: ${hangul}`, hangul), 'Hangul, 33');
  // (40 in one run is withheld; split anywhere into two of 20, it reads)
  const a = from(0x4e00, 0x9fff, 20);
  const b = from(0x4e00, 0x9fff, 20);
  assert.ok(withheld(`Error: ${a}${b}`, a + b), 'Han, 40 unsplit');
  for (const sep of ['。', '、', '「', '」', '・', '，', '：', '；', '！', '？', '　', ' ', '.', '-', ';', '!', '?']) {
    assert.ok(kept(`Error: ${a}${sep}${b}`), `split at U+${sep.codePointAt(0).toString(16)}`);
  }
});
