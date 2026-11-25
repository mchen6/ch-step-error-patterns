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
// tags are passed over, within a bound. Node's assertion properties and TAP
// diagnostics are read by their keys.
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
//   - a card's groups of digits, and 32 or more characters of groups of up to
//     seven, with one separator between them, that don't read as words together;
//   - across lines: short pieces (bare, or quoted and concatenated) are judged
//     joined, and beside a withheld line only a literal, a short number or a
//     CONSTANT_NAME stays.
// What it cannot see: a value under six characters, a number under sixteen
// digits (a decimal, up to seventeen), numbers in groups that are no card, short
// groups under 32 characters or with separators that vary, and a secret that
// reads as ordinary words; a generated value can also read so by chance, the
// shorter the likelier.
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
// (a card's own groups, with up to four other characters between two)
const CARDS = [/(?<!\d)\d{4}(?:[^A-Za-z0-9]{1,4}\d{4}){3}(?!\d)/g, /(?<!\d)\d{4}(?:[^A-Za-z0-9]{1,4}\d{4}){3}[^A-Za-z0-9]{1,4}\d{3}(?!\d)/g, /(?<!\d)\d{4}[^A-Za-z0-9]{1,4}\d{6}[^A-Za-z0-9]{1,4}\d{4,5}(?!\d)/g];
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

// Each screen judges the raw text and answers the spans it hides ([from, to]);
// screenLine hides them all at once, so none can cut a value another judges whole.
const ALL = (text) => [[0, text.length]];

function tokenSpans(token) {
  if (ESCAPES.test(token)) return ALL(token);
  if (isDecimal(token) || /^0x[0-9a-fA-F]{1,8}$/.test(token)) return [];
  const atoms = token.match(ATOM) || [];
  if (atoms.length === 0) return [];
  if (atoms.filter(scrambled).length >= 2) return ALL(token);
  if (atoms.length >= 2 && !/[/\\]/.test(token)) {
    // parts that are each short, judged as the one value they make
    if (atoms.every((a) => /^\d+$/.test(a)) && atoms.join('').length >= 16) return ALL(token);
    if (atoms.filter((a) => /^[A-Za-z]{2,}\d{2,}$/.test(a)).length >= 3) return ALL(token);
    if (atoms.filter((a) => a.length >= 3 && /^[A-Za-z]+$/.test(a) && !/[aeiouy]/i.test(a) && !NO_VOWEL.has(a.toLowerCase())).length >= 2) return ALL(token);
  }
  const unread = atoms.filter((a) => !reads(a));
  if (BASE64_RUN.test(token) && /[A-Z]/.test(token) && /[a-z]/.test(token)) {
    // (a + inside: nothing but base64 reads so. A path holds a generated name
    // among words; a key is mostly that.)
    if (/.\+/.test(token) || unread.reduce((n, a) => n + a.length, 0) * 2 >= token.length) return ALL(token);
  }
  if (unread.length === 0) return [];
  if (!/[/\\]/.test(token)) return ALL(token);
  return [...token.matchAll(ATOM)].filter((m) => !reads(m[0])).map((m) => [m.index, m.index + m[0].length]);
}

// Parts joined by a colon or an equals sign: a fingerprint, or key material.
function wideSpans(wide) {
  if (ISO_TIME.test(wide)) return [];
  const parts = wide.split(/[:=]/).filter((x) => x !== '');
  if (parts.length < 2) return [];
  if (parts.filter(scrambled).length >= 2) return ALL(wide);
  return parts.length >= 6 && parts.every((x) => /^[0-9a-fA-F]{2}$/.test(x)) ? ALL(wide) : [];
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
function cardSpans(text) {
  const out = [];
  for (const shape of CARDS) {
    shape.lastIndex = 0;
    for (let m = shape.exec(text); m !== null; m = shape.exec(text)) {
      if (isCard(m[0]) || /^\d{4}(?: \d{4}){3}$/.test(m[0])) out.push([m.index, m.index + m[0].length]);
      else shape.lastIndex = m.index + 1; // (a card can start at this one's next group)
    }
  }
  return out;
}

// A long value in short groups, one separator between them (kqzpa:bhewu:..., a
// fingerprint in fours): each
// group is too short to judge, so every stretch of GROUPED characters is judged
// as one. Words, code and paths score above GROUP_WORDS, generated letters
// below it.
const GROUP_MAX = 7;        // characters of a group
const GROUP_APART = 4;      // characters between two
const GROUPED = 32;         // a stretch: at least this long,
const GROUPED_MOST = 96;    // and longer, up to this, till it has
const GROUP_PAIRS = 12;     // letter pairs enough to score
const GROUP_WORDS = 5.3;
const UNIT = /^\d+(?:ms|us|ns|s|m|h|d|px|[kmg]?b|k|x|st|nd|rd|th)$/i;
function groupOf(text) {
  const lower = text.toLowerCase();
  const known = UNIT.test(text) || NO_VOWEL.has(lower);
  const letters = known ? [] : lower.match(/[a-z]+/g) || [];
  let pairs = 0;
  let sum = 0;
  for (const w of letters) for (let i = 0; i + 1 < w.length; i++, pairs++) sum += pairOf(w[i], w[i + 1]);
  return {size: text.length, scrambled: !known && scrambled(text), hex: /^[0-9a-f]+$/.test(lower), hexLetter: /[a-f]/.test(lower), stem: letters.join(''), pairs, sum};
}
function readsAsGroups(groups) {
  const count = (test) => groups.filter(test).length;
  if (count((g) => g.scrambled) * 2 >= groups.length) return false;
  const size = groups[0].size;
  if (size >= 2 && groups.every((g) => g.hex && g.size === size) && count((g) => g.hexLetter) * 4 >= groups.length) return false;
  const pairs = groups.reduce((n, g) => n + g.pairs, 0);
  if (pairs >= GROUP_PAIRS) return groups.reduce((n, g) => n + g.sum, 0) / pairs >= GROUP_WORDS;
  // too few pairs to score: numbers, names of one stem (v1 v2 v3) and keyed
  // numbers (a: 1, b: 2) read; mostly letters in ones and twos don't
  return count((g) => g.stem !== '') * 3 < groups.length * 2 || new Set(groups.map((g) => g.stem)).size <= 2;
}
function groupSpans(text) {
  const groups = [...text.matchAll(/[A-Za-z0-9]+/g)].map((m) => ({start: m.index, end: m.index + m[0].length, ...(m[0].length <= GROUP_MAX ? groupOf(m[0]) : {size: m[0].length})}));
  const out = [];
  const sepAfter = (k) => text.slice(groups[k].end, groups[k + 1].start);
  for (let first = 0; first + 1 < groups.length;) {
    let last = first;
    const sep = sepAfter(first);
    if (sep.length <= GROUP_APART && groups[first].size <= GROUP_MAX) {
      while (last + 1 < groups.length && groups[last + 1].size <= GROUP_MAX && sepAfter(last) === sep) last++;
    }
    for (let from = first; from < last; from++) {
      let to = from;
      let pairs = groups[from].pairs;
      const long = () => groups[to].end - groups[from].start;
      while (to < last && long() < GROUPED) pairs += groups[++to].pairs;
      if (long() < GROUPED) break;
      // (its shortest stretch, and when that has too few pairs, a longer one)
      const least = to;
      while (to < last && pairs < GROUP_PAIRS && long() < GROUPED_MOST) pairs += groups[++to].pairs;
      if (!readsAsGroups(groups.slice(from, least + 1)) || (to > least && !readsAsGroups(groups.slice(from, to + 1)))) out.push([groups[from].start, groups[to].end]);
    }
    first = Math.max(last, first + 1); // (a run's last group can start the next one)
  }
  return out;
}

const inEach = (text, shape, spansOf) => [...text.matchAll(shape)].flatMap((m) => spansOf(m[0]).map(([from, to]) => [m.index + from, m.index + to]));

// -> the line, with what can't be called readable withheld.
function screenLine(text) {
  if (UNREADABLE.test(text.replace(/\t/g, ' '))) return LINE_WITHHELD;
  const spans = [...inEach(text, WIDE, wideSpans), ...inEach(text, TOKEN, tokenSpans), ...cardSpans(text), ...groupSpans(text),
    ...inEach(text, /[A-Za-z0-9]+(?=\u2026$)/g, ALL)].sort((x, y) => x[0] - y[0]);
  let out = '';
  let at = 0;
  for (let k = 0; k < spans.length;) {
    const from = spans[k][0];
    let to = spans[k][1];
    for (k++; k < spans.length && spans[k][0] <= to; k++) to = Math.max(to, spans[k][1]);
    out += text.slice(at, from) + WITHHELD;
    at = to;
  }
  return out + text.slice(at);
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
    if (joined(run).length >= GROUPED && !readsAsGroups(run.map((r) => groupOf(r.piece)))) run.forEach(hide);
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

// Node's own shapes: an assertion's properties, after its frames, the last of
// which ends in " {"; and the diagnostic under a TAP "not ok". Of the properties,
// only the expected and actual values are read; of the diagnostic those, its
// message and its first stack line.
const OPENS = / \{\s*$/;
const KEY = /^\s*([A-Za-z_]+):(?:\s|$)/;
const CLOSER = /^\s*[\]})]/;
const NOT_OK = /^\s*not ok\b/;
const DIRECTIVE = /#\s*(?:SKIP|TODO)\b/i; // (a test that may fail)
const YAML_OPEN = /^\s*---\s*$/;
const YAML_CLOSE = /^\s*\.\.\.\s*$/;
// (a message that holds its values already)
const DIFF = /^\s*\+ actual - expected|\S !==? \S/;

// The line bound, never through a placeholder.
const cutWhole = (text, cut) => {
  const out = cut(text);
  return out === text ? out : out.replace(/<[a-z]{0,8}\u2026$/, '\u2026');
};
const indentOf = (t) => t.length - t.trimStart().length;

// [{j, body}] -> Map(key -> its lines): a key at `indent`, the lines further in,
// and a closing bracket at the key's own indent. The first of a key counts.
function sectionsOf(entries, indent) {
  const out = new Map();
  let section = null;
  for (const e of entries) {
    if (e.body.trim() === '') continue;
    const key = indentOf(e.body) === indent ? KEY.exec(e.body) : null;
    if (key !== null) {
      section = [];
      if (!out.has(key[1])) out.set(key[1], section);
    }
    if (section !== null && (key !== null || indentOf(e.body) > indent || CLOSER.test(e.body))) section.push(e);
  }
  return out;
}
const valueOf = (sections, key) => (sections.has(key) ? sections.get(key)[0].body.replace(KEY, '').replace(/,\s*$/, '').trim() : '');
// (assert.ok's `expected: true` says nothing)
function valueSections(sections) {
  if (valueOf(sections, 'expected') === 'true' && valueOf(sections, 'operator') === "'=='") return [];
  return [...sections].filter(([key]) => key === 'actual' || key === 'expected').flatMap(([, lines]) => lines);
}

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
  const bodyFor = (j, tag) => (tag === '' ? texts[j] : bodyOf(texts[j]));
  // the lines after j of the same tag, up to the first that stops
  const follow = (j, tag, stops) => {
    const entries = [];
    for (let k = j + 1; k < texts.length && k - j <= SCAN; k++) {
      if (tag !== '' && tagOf(texts[k]) !== tag) continue;
      const body = bodyFor(k, tag);
      if (stops(body)) return {entries, stop: {j: k, body}};
      entries.push({j: k, body});
    }
    return {entries, stop: null};
  };
  // the diagnostic under a "not ok", when it has values; else null
  const diagnosticAt = (i, tag) => {
    const open = follow(i, tag, (body) => body.trim() !== '').stop;
    if (open === null || !YAML_OPEN.test(open.body)) return null;
    const indent = indentOf(open.body);
    const {entries, stop} = follow(open.j, tag, (body) => (YAML_CLOSE.test(body) && indentOf(body) === indent) || NOT_OK.test(body));
    const sections = sectionsOf(entries, indent);
    if (!sections.has('expected') && !sections.has('actual')) return null;
    const message = sections.get('error') || [];
    const values = message.some((e) => DIFF.test(e.body)) ? [] : valueSections(sections);
    const keyKept = message.length > 0 && isKept(message[0].j);
    return {verdict: keyKept ? message[0].j : i, lines: [...message.slice(keyKept ? 1 : 0), ...values, ...(sections.get('stack') || []).slice(1, 2)], all: entries,
      more: stop === null || !YAML_CLOSE.test(stop.body)};
  };
  // the expected and actual among the properties after the frame at j, or null
  const propertiesAfter = (j, tag) => {
    let open = {j, body: bodyFor(j, tag)};
    if (!OPENS.test(open.body)) open = follow(j, tag, (body) => !FRAME.test(body) || OPENS.test(body)).stop;
    if (open === null || !FRAME.test(open.body)) return null;
    const first = follow(open.j, tag, () => true).stop;
    if (first === null || !KEY.test(first.body)) return null;
    const indent = indentOf(first.body);
    const {entries, stop} = follow(open.j, tag, (body) => body.trim() !== '' && indentOf(body) < indent);
    return {lines: valueSections(sectionsOf(entries, indent)), all: entries, more: stop === null};
  };
  const add = (i, raw, isCut) => {
    if (raw.length === 0) return;
    if (full) { omittedBlocks++; return; }
    // (cut: by the log, by the line bound before screening, or by it after)
    let more = isCut || raw.length > BOUNDS.PER_LINES;
    const bounded = (from, screened) => {
      const text = cutWhole(screened, cut);
      if (text !== screened || cut(from) !== from || from.trimEnd().endsWith('\u2026')) more = true;
      return text;
    };
    const values = [];
    const verdict = bounded(texts[i], screenLine(texts[i]));
    let size = verdict.length;
    const shown = raw.slice(0, BOUNDS.PER_LINES);
    for (const [k, line] of screenBlock(shown).entries()) {
      const text = bounded(shown[k], line);
      if (size + text.length > BOUNDS.PER_CHARS) { more = true; break; }
      values.push(text);
      size += text.length;
    }
    if (values.length === 0 || lines + values.length + 1 > BOUNDS.ALL_LINES || chars + size > BOUNDS.ALL_CHARS) {
      full = true;
      omittedBlocks++;
      return;
    }
    lines += values.length + 1;
    chars += size;
    blocks.push({step, index: i, verdict, values, cut: more});
  };
  for (let i = 0; i < texts.length; i++) {
    if (skipped[i] || used.has(i)) continue;
    const tag = tagOf(texts[i]);
    const diagnostic = NOT_OK.test(bodyFor(i, tag)) ? diagnosticAt(i, tag) : null;
    if (diagnostic !== null) {
      for (const e of diagnostic.all) used.add(e.j);
      if (!DIRECTIVE.test(texts[i])) add(diagnostic.verdict, diagnostic.lines.filter((e) => !isKept(e.j)).map((e) => e.body), diagnostic.more);
      continue;
    }
    if (!isVerdict(i)) continue;
    const raw = [];
    let more = false;
    let blank = 0;
    let seen = 0;
    let ended = false;
    let plain = true; // (nothing but the verdict before its first frame)
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
        raw.push(bodyFor(j, tag));
      }
      if (frame) {
        ended = true;
        const properties = plain ? propertiesAfter(j, tag) : null;
        if (properties !== null) {
          for (const e of properties.all) used.add(e.j);
          raw.push(...properties.lines.filter((e) => !isKept(e.j)).map((e) => e.body));
          if (properties.lines.length > 0 && properties.more) more = true;
        }
        break;
      }
      plain = false;
    }
    // (a bound ended the look inside the block: there may be more)
    if (!ended && j < texts.length) more = true;
    add(i, raw, more);
  }
  return blocks.length === 0 && omittedBlocks === 0 ? null : {blocks, omittedBlocks};
}

module.exports = {valueBlocks, screenBlock, screenLine, reads, BOUNDS, WITHHELD, LINE_WITHHELD};
