'use strict';
// A failed assertion's expected and actual values, kept with it. A pure
// function of the lines it is given.
//
// They are `details`, beside `lines` and never in them: they don't count
// against maxLines and never reach the failure signature (a value changes from
// run to run; the failure does not).
//
// A block: the lines after a verdict, up to a blank pair, a stack frame (the
// first of the test's own is kept, as the failure's location), the next test,
// the next failed assertion, or a bound. With parallel runners, lines of other
// tags are passed over, within a bound.
//
// These values are log text a pull request can write, and can hold what a test
// compared, so what leaves here is screened. The chain still redacts it.
// Screening fails closed and is the same wherever a value sits. Every token
// (what lies between spaces and the punctuation of quotes, brackets, JSON and
// key=value) must read as words, a plain number or a word with a short number
// at its end. Otherwise it is withheld, in place, and says so:
//   - a line with a control, format or unassigned character: all of it;
//   - a token with an escape sequence, or in a script other than ASCII;
//   - a token holding a generated part, or two scrambled short parts; in a
//     path, only the generated names;
//   - a word cut by the line bound;
//   - a card's groups of digits, whatever joins them, and 32 or more characters
//     of short groups that don't read as words together;
//   - across lines: short pieces (bare, or quoted and concatenated) are judged
//     joined, and beside a withheld line only a literal, a short number or a
//     CONSTANT_NAME stays.
// What it cannot see: a value under six characters, a number under sixteen
// digits, short groups under 32 characters, and a secret that reads as ordinary
// words; a generated value can also read so by chance, the shorter the likelier.
// It is a second line behind redaction, not a guarantee.
// PER_LINES: a failure's value lines. The other three count its verdict too.
const BOUNDS = Object.freeze({PER_LINES: 12, PER_CHARS: 1500, ALL_LINES: 40, ALL_CHARS: 4000});
const LOOK = 30;    // lines of the block's own tag, per verdict
const SCAN = 200;   // lines of any tag, per verdict
const WITHHELD = '<withheld>';
const LINE_WITHHELD = '<value line withheld>';

const UNREADABLE = /\p{C}/u;
const TOKEN = /[^\s"'`()[\]{},;|<>:=]+/g;
const ATOM = /[A-Za-z0-9]+|[^\x00-\x7f\u2026]+/g;
const WORDS = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g;
// (two in a row: one alone is a Windows path's \x64 or \123)
const ESCAPES = /(?:\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}|\\[0-7]{3}){2}/;
const FLOAT = /^[-+]?(\d{1,10})\.(\d+)(?:[eE][-+]?\d{1,3})?$/;
const FLOAT_DIGITS = 17; // what a double prints
const ISO_TIME = /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[-+]\d\d:?\d\d)?$/;
const WIDE = /[^\s"'`()[\]{},;|<>]+/g;
const SPACED_CARD = /\b\d{4}(?: \d{4}){3}\b/g;
// (a card's own groups, joined by one separator of any kind)
const CARD = /(?<!\d)\d{4}([ \t]{1,3}|[ \t]?[:=,/.|;_-][ \t]?)(?:\d{4}\1\d{4}\1\d{4}(?:\1\d{3})?|\d{6}\1\d{4,5})(?!\d)/g;
const BASE64_RUN = /^[A-Za-z0-9+/]{20,}$/;
const ACRONYM = /^[A-Z]{2,5}$/;

// How common each letter pair is in English and code, 0 to 9, a to z by a to z
// (from word lists of prose and identifiers). A word's mean is high; a
// generated string's is low.
const PAIRS = '3787256172586817287965536263436202621721630553611140705382286176208216486100406435835082054362156364204085896664633779475997476742622266207026106005455010405200735560253552065361003272047222602342720535400030667776702247798627882704062000400020100041004040000041237210502404321163302020833683128038317403656420707523822071235367225151102074788694735546742588563142556645615257796708777674327224822561372276086650113000000000000100100000600000846694528055668406776640606172842782564367337871505082639337921633740876604260666564506006684607771201206112811070001051012110001060126015601415500552000000304252025000102600050000203233421050134445105310302040205000400200200220001010';
const pairOf = (a, b) => PAIRS.charCodeAt((a.charCodeAt(0) - 97) * 26 + b.charCodeAt(0) - 97) - 48;
const SHORT_WORD = 5;
const LONG_WORD = 5.5;
// (literals, the redactor's placeholders, a stack's <anonymous>, and names with
// a digit inside that are words to anyone who reads a CI log)
const KNOWN = new Set(['undefined', 'infinity', 'anonymous', 'bearertoken', 'githubtoken', 'awskey', 'apikey', 'secret', 'privatekey', 'basicauthurl', 'email', 'phone',
  'withheld', 'base64url', 'utf8mb4', 'sha256sum', 'sha512sum', 'md5sum', 'aarch64', 'amd64', 'arm64']);

// (words of code with no vowel)
const NO_VOWEL = new Set(['http', 'https', 'html', 'xml', 'css', 'sql', 'tcp', 'udp', 'tls', 'ssl', 'ssh', 'dns', 'src', 'cmd', 'ctx', 'msg', 'pkg', 'tmp', 'cfg', 'std', 'lib', 'fn', 'db', 'fs', 'js', 'ts', 'id', 'by', 'my', 'try', 'sync', 'type', 'ms', 'npm', 'mcp', 'gh', 'cb', 'rm']);

function wordReads(word, inName) {
  if (ACRONYM.test(word) || word.length === 1) return true;
  const w = word.toLowerCase();
  if (NO_VOWEL.has(w)) return true;
  const vowel = /[aeiouy]/.test(w);
  if (w.length < 4) return !inName || vowel;
  if (!vowel) return false;
  if (w.length < 6) return true;
  let sum = 0;
  for (let i = 0; i + 1 < w.length; i++) sum += pairOf(w[i], w[i + 1]);
  return sum / (w.length - 1) >= (w.length < 8 ? SHORT_WORD : LONG_WORD);
}

// One run of letters and digits: does it read? Fails closed.
function reads(a) {
  if (!/^[A-Za-z0-9]+$/.test(a)) return false;
  if (a.length < 6) return true;
  if (/^\d+$/.test(a)) return a.length < 16;
  if (KNOWN.has(a.toLowerCase())) return true;
  // (a short number between words: oauth2Client, s3Upload)
  const between = /^([A-Za-z]+)\d{1,2}([A-Z][a-z]{3,}(?:[A-Z][a-z]+)*)$/.exec(a);
  if (between !== null && (between[1].length < 6 || reads(between[1])) && reads(between[2])) return true;
  const numbers = a.match(/\d+/g) || [];
  if (numbers.length > 1 || (numbers.length === 1 && (!/\d$/.test(a) || numbers[0].length > 4))) return false;
  const words = a.replace(/\d+$/, '').match(WORDS) || [];
  if (words.length >= 3 && words.filter((w) => w.length <= 2).length * 2 > words.length) return false;
  return words.every((w) => wordReads(w, words.length > 1));
}

// A short part that mixes letters and digits out of a name's order: x9Q, 7kL.
const scrambled = (a) => a.length >= 3 && /\d/.test(a) && /[A-Za-z]/.test(a) && (!/^[A-Za-z]+\d+$/.test(a) || /[a-z][A-Z]/.test(a));

function isDecimal(token) {
  const m = FLOAT.exec(token);
  return m !== null && `${m[1]}${m[2]}`.replace(/^0+/, '').length <= FLOAT_DIGITS;
}

function screenToken(token) {
  if (ESCAPES.test(token)) return WITHHELD;
  if (isDecimal(token) || /^0x[0-9a-fA-F]{1,8}$/.test(token)) return token;
  const atoms = token.match(ATOM) || [];
  if (atoms.length === 0) return token;
  if (atoms.filter(scrambled).length >= 2) return WITHHELD;
  if (atoms.length >= 2 && !/[/\\]/.test(token)) {
    // parts that are each short, judged as the one value they make
    if (atoms.every((a) => /^\d+$/.test(a)) && atoms.join('').length >= 16) return WITHHELD;
    if (atoms.filter((a) => /^[A-Za-z]{2,}\d{2,}$/.test(a)).length >= 3) return WITHHELD;
    if (atoms.filter((a) => a.length >= 3 && /^[A-Za-z]+$/.test(a) && !/[aeiouy]/i.test(a) && !NO_VOWEL.has(a.toLowerCase())).length >= 2) return WITHHELD;
  }
  const unread = atoms.filter((a) => !reads(a));
  if (BASE64_RUN.test(token) && /[A-Z]/.test(token) && /[a-z]/.test(token)) {
    // (a + inside: nothing but base64 reads so. A path holds a generated name
    // among words; a key is mostly that.)
    if (/.\+/.test(token) || unread.reduce((n, a) => n + a.length, 0) * 2 >= token.length) return WITHHELD;
  }
  if (unread.length === 0) return token;
  if (!/[/\\]/.test(token)) return WITHHELD;
  return token.replace(ATOM, (a) => (reads(a) ? a : WITHHELD));
}

// Parts joined by a colon or an equals sign: a fingerprint, or key material.
function screenWide(wide) {
  if (ISO_TIME.test(wide)) return wide;
  const parts = wide.split(/[:=]/).filter((x) => x !== '');
  if (parts.length < 2) return wide;
  if (parts.filter(scrambled).length >= 2) return WITHHELD;
  return parts.length >= 6 && parts.every((x) => /^[0-9a-fA-F]{2}$/.test(x)) ? WITHHELD : wide;
}

// A card's check digit (Luhn): four numbers of four digits are mostly no card.
function isCard(text) {
  const digits = text.replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i]) * (i % 2 === 1 ? 2 : 1);
    sum += d > 9 ? d - 9 : d;
  }
  return sum % 10 === 0;
}

// A long value in short groups with one separator (kqzpa:bhewu:..., a
// fingerprint in fours): each group is too short to judge, so every stretch of
// GROUPED characters is judged as one. Words and paths score well above
// GROUP_WORDS, generated letters below it.
const GROUP_SEP = /^(?:[ \t]{1,2}|, |[:=,_./\\|;-])$/;
const GROUP_MAX = 7;
const GROUPED = 32;
const GROUP_WORDS = 5.3;
const GROUP_PAIRS = 12; // letter pairs enough to score
const UNIT = /^\d+(?:ms|us|ns|s|m|h|d|px|[kmg]?b|k|x|st|nd|rd|th)$/i;
function readsAsGroups(groups) {
  if (groups.filter((g) => scrambled(g) && !UNIT.test(g)).length * 2 >= groups.length) return false;
  const size = groups[0].length;
  if (size >= 2 && groups.every((g) => g.length === size && /^[0-9a-f]+$/i.test(g)) && groups.filter((g) => /[a-f]/i.test(g)).length * 4 >= groups.length) return false;
  let sum = 0;
  let pairs = 0;
  for (const g of groups) {
    const w = g.toLowerCase();
    if (!/^[a-z]+$/.test(w) || NO_VOWEL.has(w)) continue;
    for (let i = 0; i + 1 < w.length; i++, pairs++) sum += pairOf(w[i], w[i + 1]);
  }
  return pairs < GROUP_PAIRS || sum / pairs >= GROUP_WORDS;
}
function screenGroups(text) {
  const groups = [...text.matchAll(/[A-Za-z0-9]+/g)].map((m) => ({text: m[0], start: m.index, end: m.index + m[0].length}));
  const hide = []; // [from, to] places in groups
  for (let first = 0; first + 1 < groups.length;) {
    const sep = text.slice(groups[first].end, groups[first + 1].start);
    let last = first;
    if (GROUP_SEP.test(sep) && groups[first].text.length <= GROUP_MAX) {
      while (last + 1 < groups.length && groups[last + 1].text.length <= GROUP_MAX && text.slice(groups[last].end, groups[last + 1].start) === sep) last++;
    }
    for (let from = first, to = first; from < last; from++) {
      while (to < last && groups[to].end - groups[from].start < GROUPED) to++;
      if (groups[to].end - groups[from].start < GROUPED) break;
      if (readsAsGroups(groups.slice(from, to + 1).map((g) => g.text))) continue;
      const before = hide[hide.length - 1];
      if (before !== undefined && from <= before[1]) before[1] = to;
      else hide.push([from, to]);
    }
    first = Math.max(last, first + 1); // (a run's last group can start the next one)
  }
  let out = text;
  for (const [from, to] of hide.reverse()) out = `${out.slice(0, groups[from].start)}${WITHHELD}${out.slice(groups[to].end)}`;
  return out;
}

// -> the line, with what can't be called readable withheld.
function screenLine(text) {
  if (UNREADABLE.test(text.replace(/\t/g, ' '))) return LINE_WITHHELD;
  return screenGroups(text.replace(SPACED_CARD, WITHHELD).replace(CARD, (c) => (isCard(c) ? WITHHELD : c))).replace(WIDE, screenWide).replace(TOKEN, screenToken).replace(/[A-Za-z0-9]+\u2026$/, `${WITHHELD}\u2026`);
}

// A line that is one bare value, as a diff prints it: the value, else null.
// (on the trimmed line, with no two space runs side by side: linear)
const BARE = /^(?:E\s+)?(?:[-+]\s*)?['"`]?([A-Za-z0-9+/=_-]+)['"`]?,?$/;
const bareOf = (line) => {
  const m = BARE.exec(line.trim());
  return m == null ? null : m[1];
};
const PUNCTUATION_ONLY = /^(?:[-+]\s*)?[{}()[\],;:]*$/;
const SHORT_QUOTED = /(['"`])([A-Za-z0-9+/=_-]{1,5})\1/g;
const KEEPS_BESIDE = /^(?:undefined|null|true|false|NaN|Infinity|-?\d{1,4}(?:\.\d+)?|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/;
// a short piece that isn't a word: no vowel, or letters and digits mixed
const isOdd = (p) => !KEEPS_BESIDE.test(p) && !/^\d+$/.test(p) && !(/^[A-Za-z]+$/.test(p) && /[aeiouy]/i.test(p) && !/[a-z][A-Z]/.test(p));
function piecesOf(line) {
  const bare = bareOf(line);
  if (bare !== null) return bare.length < 6 ? [{piece: bare, quote: null}] : [];
  return [...line.matchAll(SHORT_QUOTED)].map((m) => ({piece: m[2], quote: m[1]}));
}
const joined = (run) => run.map((r) => r.piece).join('').replace(/[^A-Za-z0-9]/g, '');

// -> the lines of one block, each screened, and values split over lines judged
// together.
function screenBlock(lines) {
  const out = lines.map(screenLine);
  const hidden = out.map((text, k) => text !== lines[k]);
  const content = lines.map((l, k) => k).filter((k) => !PUNCTUATION_ONLY.test(lines[k].trim()));

  // beside a withheld line, only what can't be a piece of a value stays
  content.forEach((k, n) => {
    const value = bareOf(lines[k]);
    if (value === null || hidden[k] || KEEPS_BESIDE.test(value)) return;
    const near = [content[n - 1], content[n + 1]].some((x) => x !== undefined && hidden[x] && bareOf(lines[x]) !== null);
    if (near) out[k] = lines[k].replace(value, WITHHELD);
  });

  // short pieces in a row, punctuation lines between them passed over, joined
  const hide = (r) => {
    const quoted = r.quote === null ? r.piece : `${r.quote}${r.piece}${r.quote}`;
    out[r.k] = out[r.k].replaceAll(quoted, r.quote === null ? WITHHELD : `${r.quote}${WITHHELD}${r.quote}`);
  };
  let run = [];
  const judge = () => {
    const odd = run.filter((r) => isOdd(r.piece));
    // (user1, user2, user3 are a list: one stem, numbered)
    const oneStem = new Set(odd.map((r) => r.piece.replace(/\d+$/, ''))).size === 1;
    if (odd.length >= 2 && !oneStem && !reads(joined(odd))) odd.forEach(hide);
    const digits = run.filter((r) => /^\d+$/.test(r.piece) && (r.quote !== null || r.piece.length >= 3));
    if (digits.length >= 2 && joined(digits).length >= 16) digits.forEach(hide);
    run = [];
  };
  for (const k of content) {
    const pieces = piecesOf(lines[k]);
    if (pieces.length === 0) { judge(); continue; }
    for (const p of pieces) run.push({k, ...p});
  }
  judge();
  return out;
}

const FRAME = /^\s+at\s|^\s+File "/;
const INTERNAL_FRAME = /^\s*at\s(?:.*\()?node:internal\//;
// what starts something else: a test's result, another failure, a runner's
// section or header
const ENDS = /^\s*(?:[\u2714\u2713\u2716\u25cf\ufe63]|ok\s|not ok\b|--- (?:FAIL|PASS|SKIP):|=== (?:RUN|PAUSE|CONT|NAME)\s|---- |##\[|test .+ \.\.\. |failures:|note: |(?:PASS|FAIL)\s|(?:FAIL|ERROR):|_{3,}\s|={5,}|-{5,})|^\s*(?:[\w.]+\.)?AssertionError\b|^\S+:\d+: \w*Error\s*$/;
// a verdict that isn't kind 'assert': a Rust panic, testify's verdict, the
// first of pytest's E lines
const HEAD = /^\s*thread '.*'(?: \(\d+\))? panicked at |^\s*Error:\s+(?:Not equal|Should\b|Expected\b|Received\b)/;
const PYTEST_E = /^E\s{2,}\S/;
// a line that states a failure of its own, unless it continues this one
// (a diff's own line, Jest's Expected/Received, pytest's E lines, testify's
// fields, Rust's left and right)
const STATES = /Assertion|\b[Ee]xpected\b|panicked at|Error:/;
const CONTINUES = /^\s*[-+]|^\s*(?:Expected|Received)(?: [\w ]+)?:|^E\s|^\s*(?:Error Trace|Error|Test|Messages):\s*\t|^\s*(?:expected|actual)\s*:|^\s*(?:left|right):|^\s*assertion\b/;

// The line bound, never through a placeholder.
const cutWhole = (text, cut) => {
  const out = cut(text);
  return out === text ? out : out.replace(/<[a-z]{0,8}\u2026$/, '\u2026');
};
const indentOf = (t) => t.length - t.trimStart().length;

// {texts, kinds, skipped} of one step; isKept(index): the line is in `lines`
// already; tagOf, bodyOf: a line's parallel-runner tag and what follows it;
// cut: the line bound. -> {blocks: [{step, index, verdict, values, cut}],
// omittedBlocks}, or null when the step has no failed assertion with values.
function valueBlocks({texts, kinds, skipped, isKept, tagOf, bodyOf, step, cut}) {
  const used = new Set();
  const blocks = [];
  let omittedBlocks = 0;
  let lines = 0;
  let chars = 0;
  let full = false;
  const isVerdict = (i) => {
    const body = bodyOf(texts[i]);
    if (kinds[i] === 'assert' || (kinds[i] === 'error' && HEAD.test(body))) return true;
    return PYTEST_E.test(body) && !(i > 0 && PYTEST_E.test(bodyOf(texts[i - 1])));
  };
  const startsAnother = (j, body) => isVerdict(j) && STATES.test(body) && !CONTINUES.test(body);
  for (let i = 0; i < texts.length; i++) {
    if (skipped[i] || used.has(i) || !isVerdict(i)) continue;
    const tag = tagOf(texts[i]);
    const raw = [];
    let more = false;
    let blank = 0;
    let seen = 0;
    let ended = false;
    let j = i + 1;
    for (; j < texts.length && seen < LOOK && j - i <= SCAN; j++) {
      if (skipped[j] || (tag !== '' && tagOf(texts[j]) !== tag)) continue;
      seen++;
      const body = bodyOf(texts[j]);
      if (body.trim() === '') {
        if (++blank >= 2) { ended = true; break; }
        continue;
      }
      blank = 0;
      if (INTERNAL_FRAME.test(body)) continue;
      const frame = FRAME.test(body);
      // (mocha's next failure sits left of this one's error; a list in a value does not)
      const nextNumbered = /^\s*\d+\) /.test(body) && indentOf(body) < indentOf(bodyOf(texts[i]));
      if (!frame && (nextNumbered || ENDS.test(body) || startsAnother(j, body))) { ended = true; break; }
      used.add(j);
      if (!isKept(j)) {
        if (raw.length >= BOUNDS.PER_LINES) { more = true; ended = true; break; }
        raw.push(tag === '' ? texts[j] : body);
      }
      if (frame) { ended = true; break; }
    }
    // (a bound ended the look inside the block: there may be more)
    if (!ended && j < texts.length) more = true;
    if (raw.length === 0) continue;
    if (full) { omittedBlocks++; continue; }
    // (cut: by the log, by the line bound before screening, or by it after)
    const bounded = (from, screened) => {
      const text = cutWhole(screened, cut);
      if (text !== screened || cut(from) !== from || from.trimEnd().endsWith('\u2026')) more = true;
      return text;
    };
    const values = [];
    const verdict = bounded(texts[i], screenLine(texts[i]));
    let size = verdict.length;
    for (const [k, line] of screenBlock(raw).entries()) {
      const text = bounded(raw[k], line);
      if (size + text.length > BOUNDS.PER_CHARS) { more = true; break; }
      values.push(text);
      size += text.length;
    }
    if (values.length === 0 || lines + values.length + 1 > BOUNDS.ALL_LINES || chars + size > BOUNDS.ALL_CHARS) {
      full = true;
      omittedBlocks++;
      continue;
    }
    lines += values.length + 1;
    chars += size;
    blocks.push({step, index: i, verdict, values, cut: more});
  }
  return blocks.length === 0 && omittedBlocks === 0 ? null : {blocks, omittedBlocks};
}

module.exports = {valueBlocks, screenBlock, screenLine, reads, BOUNDS, WITHHELD, LINE_WITHHELD};
