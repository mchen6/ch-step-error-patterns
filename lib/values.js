'use strict';
// A failed assertion's expected and actual values, kept with it. A pure
// function of the lines it is given.
//
// They are `details`, beside `lines`: what is here doesn't count against maxLines
// and never reaches the failure signature (a value changes from run to run; the
// failure does not). A line of a block can be in `lines` too, for its own sake.
//
// A block: the lines after a verdict in the failing step, up to a stack frame
// (the first of the test's own is kept, as the failure's location); a line that
// is neither a diff's nor a value's, outside any open bracket, and indented less
// than the verdict or, when the verdict isn't indented, not at all (a Rust panic's
// message, the line after its head, is the exception); two blank lines, with
// nothing but a code frame between them; the next test; the next failed assertion;
// or a bound. Code frames are
// passed over, and with parallel runners so are lines of other tags, within a
// bound. Node's assertion properties and TAP diagnostics are read by their keys.
//
// These values are log text a pull request can write, and can hold what a test
// compared, so what leaves here is screened. The chain still redacts it.
// What can't be read is hidden. Every screen judges a line's raw text, and what
// they hide is merged and hidden at once:
//   - a line with a control, format or unassigned character: all of it;
//   - a token (what lies between spaces and the punctuation of quotes, brackets,
//     JSON and key=value) that doesn't read as words, a plain number or a word
//     with a short number at its end; in a path, only its generated names;
//   - a token with an escape sequence; a token mixing letters outside ASCII
//     with digits; letters of two scripts in one run (letters of one script
//     read as words, and symbols as symbols: business, 11-28);
//   - twelve or more characters without a space: fewer than half of their
//     letters in words, or, with under five letters, two kinds of mark inside
//     that numbers, dates, versions, paths, brackets and quotes don't have;
//   - 32 or more characters of groups of up to seven, with one separator between
//     them (a run of blanks is one), that don't read as words together;
//   - digits, each time with the whole run of digits they are in: four fours a
//     space apart, or a card number in its usual groups whose check digit holds;
//     24 or more digits with three groups in a row of one width, four or more;
//     and sixteen or more numbers that are bytes, 0 to 255 or signed, mostly
//     large. A list in order is a list;
//   - on a line that was cut, the stretch the cut is in, and the odd groups
//     before it;
//   - across lines: short pieces (bare, or quoted and concatenated) and lines of
//     numbers are judged joined; and a bare value beside a withheld one stays
//     only if it is a literal, a short number or a CONSTANT_NAME.
// What it cannot see: a value under six characters; a number under sixteen
// digits (a decimal, up to seventeen); other numbers in groups: up to 23 digits,
// groups of two or three or of uneven widths, thousands commas, and any in order;
// short groups under 32 characters, or with separators that vary and spaces
// between them; a secret that reads as ordinary words; and a short value in
// the letters of a script other than Latin (an alphabet's run up to 24
// letters, Han, kana or Hangul up to 32 characters, read as words). A generated value can also read so by
// chance, the shorter the likelier.
// It is a second line behind redaction, not a guarantee.
// PER_LINES: a failure's value lines. The other three count its verdict too.
const BOUNDS = Object.freeze({PER_LINES: 12, PER_CHARS: 1500, ALL_LINES: 40, ALL_CHARS: 4000});
const LOOK = 30;    // lines of the block's own tag, per verdict
const SCAN = 200;   // lines of any tag, per verdict
// Lines looked at for all of a call's failures. Past it each assertion line counts
// as left out, whether or not it had values, so omittedBlocks is an estimate.
const SCAN_ALL = 20000;
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
const NO_VOWEL = new Set(['http', 'https', 'html', 'xml', 'css', 'sql', 'tcp', 'udp', 'tls', 'ssl', 'ssh', 'dns', 'src', 'cmd', 'ctx', 'msg', 'pkg', 'tmp', 'cfg', 'std', 'lib', 'fn', 'db', 'fs', 'js', 'ts', 'id', 'by', 'my', 'try', 'sync', 'type', 'ms', 'npm', 'mcp', 'gh', 'cb', 'rm', 'ch', 'php', 'fpm', 'js', 'db']);

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

// Letters of one script (business, 11-28: words in any script read as words).
// Japanese mixes its kana and kanji, Korean its Hangul and Hanja: each counts
// as one. A run of letters across scripts doesn't read.
const SCRIPTS = [/^[\p{Script=Latin}\p{M}]+$/u, /^[\p{Script=Greek}\p{M}]+$/u, /^[\p{Script=Cyrillic}\p{M}]+$/u,
  /^[\p{Script=Armenian}\p{M}]+$/u, /^[\p{Script=Georgian}\p{M}]+$/u, /^[\p{Script=Hebrew}\p{M}]+$/u,
  /^[\p{Script=Arabic}\u0640\u200c\p{M}]+$/u, /^[\p{Script=Devanagari}\p{M}]+$/u, /^[\p{Script=Bengali}\p{M}]+$/u,
  /^[\p{Script=Gurmukhi}\p{M}]+$/u, /^[\p{Script=Gujarati}\p{M}]+$/u, /^[\p{Script=Tamil}\p{M}]+$/u,
  /^[\p{Script=Telugu}\p{M}]+$/u, /^[\p{Script=Kannada}\p{M}]+$/u, /^[\p{Script=Malayalam}\p{M}]+$/u,
  /^[\p{Script=Sinhala}\p{M}]+$/u, /^[\p{Script=Ethiopic}\p{M}]+$/u,
  /^[\p{Script=Thai}\p{M}]+$/u, /^[\p{Script=Lao}\p{M}]+$/u, /^[\p{Script=Khmer}\p{M}]+$/u, /^[\p{Script=Myanmar}\p{M}]+$/u,
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\u3005\uff70\uff9e\uff9f\p{M}]+$/u,
  /^[\p{Script=Hangul}\p{Script=Han}\p{M}]+$/u];
const oneScript = (a) => /^[\p{L}\p{M}\u30fc\u0640\u200c\uff70\uff9e\uff9f]+$/u.test(a) && SCRIPTS.some((re) => re.test(a));
// (a run outside ASCII, read piece by piece between its punctuation, symbols
// and spaces: a Japanese sentence's full stop, guillemets, corner brackets)
const pieces = (a) => a.split(/[\p{P}\p{S}\p{Zs}]+/u).filter((x) => x !== '');
// A letter that isn't Latin (accented Latin letters are folded and read as
// ASCII words: latinFolded)
const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;
// letters outside Latin mixed with digits: a value written in another script
const mixedNonLatin = (x) => NON_LATIN_LETTER.test(x) && /[0-9\p{Nd}]/u.test(x) && !MICROS.test(x) && !cjkDigitsRead(x);
// Never read (business, 11-28): Braille (a byte a pattern), emoji and
// pictographs (encodings use them), private use; a test runner's heavy check
// and cross (U+2714, U+2716) are marks, not pictures.
const NEVER = /[\u2800-\u28ff\p{Co}\u{1f1e6}-\u{1f1ff}]|(?![\u2714\u2716\u2139\u26a0\u23f1])\p{Extended_Pictographic}/u;
// A run of marks with no letter or digit: a test runner's marks, an arrow.
// (up to 4 marks: a runner prints one or two; a long run is a value's)
// (U+2139, node --test's info mark, is a letter by its category)
const symbolsOnly = (a) => /^[\p{S}\p{P}\p{Zs}\u2139]+$/u.test(a) && !NEVER.test(a) && [...a].length <= 4;
// How long a run of one script reads (business, 11-28): an alphabet's words
// are shorter than 24 letters; Han, kana and Hangul have no spaces between
// words, so 32 characters between punctuation, which still catches a long
// encoded value. A short value in another script's letters can read.
const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u30fc\u3005\uff70\uff9e\uff9f\p{M}]+$/u;
const lettersIn = (r) => [...r].filter((c) => /\p{L}/u.test(c)).length;
const foldsToAscii = (c) => /^[\x00-\x7f]*$/.test(c.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC'));
const runReads = (r) => {
  // (three marks or more on one letter: no script writes so)
  if (/\p{M}{3,}/u.test(r)) return false;
  // (Latin that folds to ASCII is judged folded, by tokenSpans; Latin that
  // doesn't, an alphabet's bound)
  if (/^[\p{Script=Latin}\p{M}]+$/u.test(r)) return [...r].every(foldsToAscii) || lettersIn(r) <= 24;
  return CJK_RUN.test(r) ? lettersIn(r) <= 32 : lettersIn(r) <= 24;
};
// A token's letters outside ASCII in total (business, 11-28): Han, kana,
// Hangul and the scripts with no spaces up to 64 (with the short digit groups
// of their runs), an alphabet's up to 32; past it, the rest of the token is
// withheld. -> the index the rest starts at, or -1.
const NO_SPACE_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u30fc\u3005\uff70]/u;
function capAt(token) {
  let wide = 0;
  let alpha = 0;
  let inWide = false;
  for (let i = 0; i < token.length;) {
    const c = String.fromCodePoint(token.codePointAt(i));
    if (NO_SPACE_LETTER.test(c)) { wide++; inWide = true; }
    else if (/[0-9]/.test(c) && inWide) wide++;
    else if (/\p{L}/u.test(c) && !/[\x00-\x7f]/.test(c) && !foldsToAscii(c)) { alpha++; inWide = false; }
    else if (!/\p{M}/u.test(c)) inWide = /[0-9]/.test(c) ? inWide : false;
    if (wide > 64 || alpha > 32) return i;
    i += c.length;
  }
  return -1;
}
// A run of Han, kana or Hangul with short digit groups inside it, as one
// (business, 11-28): "the 3rd test", "line 12". Groups over 6 digits don't.
const CJK_DIGITS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc\u3005]+(?:[0-9]{1,6}[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc\u3005]+)*|[0-9]{1,6}(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;
// digits only in short groups beside Han, kana or Hangul, each run (with its
// digits) within the no-space bound
const cjkDigitsRead = (x) => {
  if (!/[0-9]/.test(x) || /[0-9]{7,}/.test(x)) return false;
  const rest = x.replace(CJK_DIGITS, (m) => (m.length <= 32 ? '' : m));
  return !/[0-9]/.test(rest) && !NON_LATIN_LETTER.test(rest.replace(/[\x00-\x7f]/g, ''));
};
// a duration in microseconds, written with either mu
const MICROS = /^\d+(?:\.\d+)?[\u00b5\u03bc]s$/;
// A token's Latin letters outside ASCII (accented, extended, fullwidth),
// folded to ASCII, so the ASCII screen judges them -> {text, aligned: each
// character folded to as many units as it had}, or null for none
function latinFolded(token) {
  if (!/(?=\p{Script=Latin})[^\x00-\x7f]/u.test(token)) return null;
  let aligned = true;
  const text = [...token].map((c) => {
    if (!/(?=\p{Script=Latin})[^\x00-\x7f]/u.test(c)) return c;
    const f = c.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC');
    if (f.length !== c.length) aligned = false;
    return f;
  }).join('');
  return {text, aligned};
}

// One run of letters and digits: does it read? Fails closed. A run outside
// ASCII reads when it is symbols only, or letters of one script; one that
// holds a digit outside ASCII, or letters of two scripts, does not.
function reads(a) {
  if (!/^[\x00-\x7f]+$/.test(a)) {
    if (NEVER.test(a) || /\p{N}/u.test(a)) return false;
    // (a mark with no letter before it)
    if (/(^|[^\p{L}\p{M}])\p{M}/u.test(a)) return false;
    if (/^[\p{S}\p{P}\p{Zs}\u2139]+$/u.test(a)) return symbolsOnly(a);
    const parts = pieces(a);
    return parts.length > 0 && parts.every((r) => oneScript(r) && runReads(r));
  }
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

// parts that are each short, judged as the one value they make
function joinedOdd(atoms) {
  if (atoms.length < 2) return false;
  if (atoms.every((a) => /^\d+$/.test(a)) && atoms.join('').length >= 16) return true;
  if (atoms.filter((a) => /^[A-Za-z]{2,}\d{2,}$/.test(a)).length >= 3) return true;
  return atoms.filter((a) => a.length >= 3 && /^[A-Za-z]+$/.test(a) && !/[aeiouy]/i.test(a) && !NO_VOWEL.has(a.toLowerCase())).length >= 2;
}

function tokenSpans(token) {
  if (ESCAPES.test(token)) return ALL(token);
  if (isDecimal(token) || /^0x[0-9a-fA-F]{1,8}$/.test(token)) return [];
  // (Latin letters outside ASCII: the token folded to ASCII is judged; its
  // spans where the fold kept each character in place, else the token)
  // (past the token cap, the rest of the token; what is before it judged)
  const cap = capAt(token);
  if (cap > 0) return [...tokenSpans(token.slice(0, cap)), [cap, token.length]];
  if (cap === 0) return ALL(token);
  if (MICROS.test(token)) return [];
  const folded = latinFolded(token);
  if (folded !== null && folded.text !== token) {
    const spans = tokenSpans(folded.text);
    if (spans.length > 0) return folded.aligned ? spans : ALL(token);
  }
  const atoms = token.match(ATOM) || [];
  if (atoms.length === 0) return [];
  if (atoms.filter(scrambled).length >= 2) return ALL(token);
  // (letters outside Latin mixed with digits in one token: a value written in
  // another script, withheld whole; in a path, the segment that holds them)
  if (!/[/\\]/.test(token) && mixedNonLatin(token)) return ALL(token);
  if (!/[/\\]/.test(token)) {
    if (joinedOdd(atoms)) return ALL(token);
  } else {
    // (in a path: the segment it is in; and the screen goes on over the
    // others -- release 1 returned here, so a character outside ASCII in
    // another segment passed)
    const segments = inEach(token, /[^/\\]+/g, (x) => (joinedOdd(x.match(ATOM) || []) || mixedNonLatin(x) ? ALL(x) : []));
    if (segments.length > 0) {
      const rest = [...token.matchAll(ATOM)].filter((m) => !reads(m[0])).map((m) => [m.index, m.index + m[0].length]);
      return [...segments, ...rest];
    }
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
// -> (from, to): does that stretch of groups read? By running totals, so each
// answer is cheap however many are asked.
function groupReader(groups) {
  const total = (of) => groups.reduce((sums, g) => { sums.push(sums[sums.length - 1] + Number(of(g))); return sums; }, [0]);
  const sums = {scrambled: total((g) => g.scrambled), hexLetter: total((g) => g.hexLetter), pairs: total((g) => g.pairs), sum: total((g) => g.sum), stem: total((g) => g.stem !== '')};
  // how far back the groups are hex of one size
  const alike = [];
  groups.forEach((g, k) => alike.push(!g.hex || g.size < 2 ? 0 : k > 0 && alike[k - 1] > 0 && groups[k - 1].size === g.size ? alike[k - 1] + 1 : 1));
  return (from, to) => {
    const n = to - from + 1;
    const of = (key) => sums[key][to + 1] - sums[key][from];
    if (of('scrambled') * 2 >= n) return false;
    if (alike[to] >= n && of('hexLetter') * 4 >= n) return false;
    if (of('pairs') >= GROUP_PAIRS) return of('sum') / of('pairs') >= GROUP_WORDS;
    // too few pairs to score: numbers, names of one stem (v1 v2 v3) and keyed
    // numbers (a: 1, b: 2) read; mostly letters in ones and twos don't
    if (of('stem') * 3 < n * 2) return true;
    const stems = new Set();
    for (let k = from; k <= to && stems.size <= 2; k++) stems.add(groups[k].stem);
    return stems.size <= 2;
  };
}
const readsAsGroups = (groups) => groupReader(groups)(0, groups.length - 1);
function groupSpans(text) {
  const groups = [...text.matchAll(/[A-Za-z0-9]+/g)].map((m) => ({start: m.index, end: m.index + m[0].length, ...(m[0].length <= GROUP_MAX ? groupOf(m[0]) : {size: m[0].length})}));
  const out = [];
  const upTo = groups.reduce((sums, g) => { sums.push(sums[sums.length - 1] + g.size); return sums; }, [0]);
  // (a run of blanks is one separator: a dump's halves are two blanks apart)
  const sepAfter = (k) => text.slice(groups[k].end, groups[k + 1].start).replace(/[ \t]+/g, ' ');
  for (let first = 0; first + 1 < groups.length;) {
    let last = first;
    const sep = sepAfter(first);
    if (sep.length <= GROUP_APART && groups[first].size <= GROUP_MAX) {
      while (last + 1 < groups.length && groups[last + 1].size <= GROUP_MAX && sepAfter(last) === sep) last++;
    }
    const readAt = last > first ? groupReader(groups.slice(first, last + 1)) : null;
    for (let from = first; from < last; from++) {
      let to = from;
      let pairs = groups[from].pairs;
      // (the separators as one blank each: padding makes no value long)
      const long = () => upTo[to + 1] - upTo[from] + (to - from) * sep.length;
      while (to < last && long() < GROUPED) pairs += groups[++to].pairs;
      if (long() < GROUPED) break;
      // (its shortest stretch, and when that has too few pairs, a longer one)
      const least = to;
      while (to < last && pairs < GROUP_PAIRS && long() < GROUPED_MOST) pairs += groups[++to].pairs;
      if (!readAt(from - first, least - first) || (to > least && !readAt(from - first, to - first))) out.push([groups[from].start, groups[to].end]);
    }
    first = Math.max(last, first + 1); // (a run's last group can start the next one)
  }
  return out;
}

// A long value with punctuation: each piece between its marks is too short to
// judge, so every STRETCH characters without a space are, by how many of their
// letters are in words. Code, JSON and paths are mostly words.
// (Why 12 and not 16: the marks at a value's ends are in no group, so at 16 many
// generated values of 16 characters with punctuation were never judged. At 12
// most are. It hides a little more of real logs: temporary folders' names,
// download ids, long command lines. It also judges values under 24 characters.)
const STRETCH = 12;
const STRETCH_LETTERS = 5; // letters enough to judge
const TWO_LETTERS = new Set(['an', 'as', 'at', 'be', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'no', 'of', 'ok', 'on', 'or', 'so', 'to', 'up', 'us', 'we']);
const wordMean = (w) => { let sum = 0; for (let i = 0; i + 1 < w.length; i++) sum += pairOf(w[i], w[i + 1]); return sum / (w.length - 1); };
function isWord(word) {
  const w = word.toLowerCase();
  if (w.length >= 2 && (NO_VOWEL.has(w) || KNOWN.has(w) || TWO_LETTERS.has(w))) return true;
  return w.length >= 3 && wordMean(w) >= (w.length === 3 ? 5 : 4.5);
}
const isPlain = (g) => g.letters >= 3 && g.words === g.letters && g.to - g.from === g.letters;
// With fewer letters than that (hex or digits among marks): by how many kinds of
// mark are inside, not counting those of numbers, dates, versions and paths, nor
// brackets and quotes, so lists, JSON, Sets and Maps stay. The known cost: a regex
// with few letters (a failed match's expected pattern can be one), a list of
// percentages joined by semicolons, a line of assignments with no spaces, a chain
// of && and ||, and two version ranges joined without spaces (~1.2.0||^2.0.0, a
// name@1.2!=1.3) are withheld.
const FEW_LETTERS_MARKS = 2;
const marksIn = (text) => new Set(text.replace(/[A-Za-z0-9.,:/+_()[\]{}<>'"`-]/g, '')).size;
function stretchSpans(text) {
  const out = [];
  for (const m of text.matchAll(/\S{12,}/g)) {
    const groups = [...m[0].matchAll(/[A-Za-z0-9]+/g)].map((g) => ({from: g.index, to: g.index + g[0].length, letters: g[0].replace(/\d/g, '').length,
      words: (g[0].match(WORDS) || []).filter(isWord).reduce((n, w) => n + w.length, 0)}));
    const ranges = []; // [first, last] places in groups, joined where they overlap
    for (let i = 0; i < groups.length; i++) {
      let letters = 0;
      let words = 0;
      let j = i;
      for (; j < groups.length; j++) {
        letters += groups[j].letters;
        words += groups[j].words;
        if (groups[j].to - groups[i].from >= STRETCH) break;
      }
      if (j === groups.length) break;
      if (letters < STRETCH_LETTERS ? marksIn(m[0].slice(groups[i].from, groups[j].to)) < FEW_LETTERS_MARKS : words * 2 >= letters) continue;
      // (a word at its edge is no part of it)
      let first = i;
      let last = j;
      while (first < last && isPlain(groups[first])) first++;
      while (last > first && isPlain(groups[last])) last--;
      const before = ranges[ranges.length - 1];
      if (before !== undefined && first <= before[1]) before[1] = Math.max(before[1], last);
      else ranges.push([first, last]);
    }
    // (and each goes on, either way, to a quote, the end of the stretch or a word)
    for (const [first, last] of ranges) {
      let {from} = groups[first];
      let {to} = groups[last];
      for (let k = first - 1; ; k--) {
        const gap = m[0].slice(k < 0 ? 0 : groups[k].to, from);
        from -= /[^"'`]*$/.exec(gap)[0].length;
        if (k < 0 || /["'`]/.test(gap) || isPlain(groups[k])) break;
        from = groups[k].from;
      }
      for (let k = last + 1; ; k++) {
        const gap = m[0].slice(to, k === groups.length ? m[0].length : groups[k].from);
        to += /^[^"'`]*/.exec(gap)[0].length;
        if (k === groups.length || /["'`]/.test(gap) || isPlain(groups[k])) break;
        to = groups[k].to;
      }
      out.push([m.index + from, m.index + to]);
    }
  }
  return out;
}

// Long digits in groups: numbers with no letter between them and few other
// characters. A list that only rises or falls is a list.
const NUMBERS_APART = 8;
const sorted = (n) => n.every((x, k) => k === 0 || x >= n[k - 1]) || n.every((x, k) => k === 0 || x <= n[k - 1]);
// Sixteen bytes or more: 0 to 255 (a sign can be a diff's, and one number of the
// run can be another's), or signed. Most are large, as small counts are not, and
// they aren't in order.
function isBytes(run) {
  if (run.length < 16 || !run.every((g) => g.text.length <= 3)) return false;
  const numbers = run.map((g) => (g.minus ? -1 : 1) * Number(g.text));
  if (sorted(numbers)) return false;
  const large = (least) => numbers.filter((n) => Math.abs(n) >= least).length * 4 >= run.length;
  if (numbers.every((n) => Math.abs(n) <= 255) && large(100)) return true;
  return numbers.some((n) => n < 0) && numbers.every((n) => n >= -128 && n <= 127) && large(50);
}
function hidesDigits(run, cards) {
  // (what the redactor masked in the middle was part of it)
  if (run.some((g) => g.masked) && run.reduce((n, g) => n + (g.masked ? 0 : g.text.length), 0) >= 12) return true;
  const numbers = run.filter((g) => !g.masked).map((g) => (g.minus ? -1 : 1) * Number(g.text));
  if (cards.some(([from, to]) => from < run[run.length - 1].to && to > run[0].from)) return true;
  // (three or four can be in order by chance: then they are near each other)
  if (sorted(numbers) && (run.length >= 5 || Math.max(...numbers) - Math.min(...numbers) < Math.max(...numbers) / 10)) return false;
  // a key as a list of bytes, with its length before it or not
  if (isBytes(run) || isBytes(run.slice(1))) return true;
  if (run.reduce((n, g) => n + g.text.length, 0) < 24) return false;
  return run.some((g, k) => g.text.length >= 4 && k >= 2 && run[k - 1].text.length === g.text.length && run[k - 2].text.length === g.text.length);
}
function digitSpans(text) {
  const cards = cardSpans(text);
  const out = [...cards];
  let run = [];
  const end = () => {
    if (run.length >= 2 && hidesDigits(run, cards)) out.push([run[0].from, run[run.length - 1].to]);
    run = [];
  };
  for (const m of text.matchAll(/<(?:card|phone|ipv4|secret|token)>|[A-Za-z0-9]+/g)) {
    const masked = m[0].startsWith('<');
    if (!masked && !/^\d+$/.test(m[0])) { end(); continue; }
    if (run.length > 0 && m.index - run[run.length - 1].to > NUMBERS_APART) end();
    run.push({text: m[0], masked, minus: /(?:^|[^A-Za-z0-9])-$/.test(text.slice(Math.max(0, m.index - 2), m.index)), from: m.index, to: m.index + m[0].length});
  }
  end();
  return out;
}

// A line that ends where it was cut: the whole stretch the cut is in (it may be
// the head of a value), and the short groups before it when they read as one.
const CUT_WORD = 4; // the mean letter pair of a four-letter word, at least
const oddGroup = (g) => scrambled(g) || (/^\d+$/.test(g) && g.length >= 3)
  || (/^[A-Za-z]+$/.test(g) && !NO_VOWEL.has(g.toLowerCase()) && ((g.length >= 3 && !/[aeiouy]/i.test(g)) || (g.length >= 4 && wordMean(g.toLowerCase()) < CUT_WORD)));
const cutAt = (text) => (text.trimEnd().endsWith('\u2026') ? text.trimEnd().length - 1 : -1);
function cutSpans(text) {
  const end = cutAt(text);
  if (end === -1) return [];
  const stretch = /\S*$/.exec(text.slice(Math.max(0, text.lastIndexOf(' ', end), text.lastIndexOf('\t', end)), end).trimStart())[0].length;
  const groups = [...text.slice(0, end).matchAll(/[A-Za-z0-9]+/g)].map((g) => ({text: g[0], from: g.index, to: g.index + g[0].length}));
  let k = groups.length - 1;
  const sep = k >= 1 ? text.slice(groups[k - 1].to, groups[k].from) : '';
  while (k >= 1 && sep.length <= GROUP_APART && groups[k - 1].text.length <= GROUP_MAX && text.slice(groups[k - 1].to, groups[k].from) === sep && oddGroup(groups[k - 1].text)) k--;
  const from = Math.min(end - stretch, k >= 0 ? groups[k].from : end);
  return from < end ? [[from, end]] : [];
}

const inEach = (text, shape, spansOf) => [...text.matchAll(shape)].flatMap((m) => spansOf(m[0]).map(([from, to]) => [m.index + from, m.index + to]));

// -> null for a line withheld whole, else the spans it hides.
function spansIn(text) {
  if (UNREADABLE.test(text.replace(/\t/g, ' ').replace(/(?<=\p{Script=Arabic})\u200c(?=\p{Script=Arabic})/gu, ''))) return null;
  const spans = [...inEach(text, WIDE, wideSpans), ...inEach(text, TOKEN, tokenSpans), ...groupSpans(text), ...stretchSpans(text), ...digitSpans(text), ...cutSpans(text)];
  // (the mark of a cut stays)
  const end = cutAt(text);
  return end === -1 ? spans : spans.map(([from, to]) => [from, Math.min(to, end)]).filter(([from, to]) => from < to);
}
function withoutSpans(text, spans) {
  if (spans === null) return LINE_WITHHELD;
  const sortedSpans = [...spans].sort((x, y) => x[0] - y[0]);
  let out = '';
  let at = 0;
  for (let k = 0; k < sortedSpans.length;) {
    const from = sortedSpans[k][0];
    let to = sortedSpans[k][1];
    for (k++; k < sortedSpans.length && sortedSpans[k][0] <= to; k++) to = Math.max(to, sortedSpans[k][1]);
    out += text.slice(at, from) + WITHHELD;
    at = to;
  }
  return out + text.slice(at);
}
// -> the line, with what can't be called readable withheld.
// (each line composed first, NFC: an accent written apart stays with its letter)
const screenLine = (raw) => { const text = raw.normalize('NFC'); return withoutSpans(text, spansIn(text)); };

// A line that is one bare value, as a diff prints it: the value, else null.
// (on the trimmed line, with no two space runs side by side: linear)
const BARE = /^\s*(?:E\s+)?(?:[-+]\s*)?['"`]?([A-Za-z0-9+/=_-]+)['"`]?,?$/d;
const bareOf = (line) => {
  const m = BARE.exec(line.trimEnd());
  return m == null ? null : {text: m[1], span: m.indices[1]};
};
const NUMBERS_ONLY = /^(?=.*\d)[-+\s\d.,[\](){};]+$/;
const PUNCTUATION_ONLY = /^(?:[-+]\s*)?[{}()[\],;:]*$/;
const SHORT_QUOTED = /(['"`])([A-Za-z0-9+/=_-]{1,5})\1/g;
const KEEPS_BESIDE = /^(?:undefined|null|true|false|NaN|Infinity|-?\d{1,4}(?:\.\d+)?|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/;
// a short piece that isn't a word: no vowel, or letters and digits mixed
const isOdd = (p) => !KEEPS_BESIDE.test(p) && !/^\d+$/.test(p) && !(/^[A-Za-z]+$/.test(p) && /[aeiouy]/i.test(p) && !/[a-z][A-Z]/.test(p));
function piecesOf(line) {
  const bare = bareOf(line);
  if (bare !== null) return bare.text.length < 6 ? [{piece: bare.text, quote: null, span: bare.span}] : [];
  return [...line.matchAll(SHORT_QUOTED)].map((m) => ({piece: m[2], quote: m[1], span: [m.index + 1, m.index + 1 + m[2].length]}));
}
const joined = (run) => run.map((r) => r.piece).join('').replace(/[^A-Za-z0-9]/g, '');

// -> the lines of one block, each screened, and values split over lines judged
// together.
function screenBlock(raw) {
  const lines = raw.map((l) => l.normalize('NFC'));
  const spans = lines.map(spansIn);
  const hidden = spans.map((x) => x === null || x.length > 0);
  const hide = (k, span) => { if (spans[k] !== null) spans[k].push(span); };
  const content = lines.map((l, k) => k).filter((k) => !PUNCTUATION_ONLY.test(lines[k].trim()));

  // beside a withheld line, only what can't be a piece of a value stays
  const bare = lines.map(bareOf);
  content.forEach((k, n) => {
    if (bare[k] === null || hidden[k] || KEEPS_BESIDE.test(bare[k].text)) return;
    if ([content[n - 1], content[n + 1]].some((x) => x !== undefined && hidden[x] && bare[x] !== null)) hide(k, bare[k].span);
  });

  // numbers over lines, as one run
  for (let k = 0; k < lines.length;) {
    let end = k;
    while (end < lines.length && NUMBERS_ONLY.test(lines[end])) end++;
    if (end - k >= 2) {
      const starts = [];
      let at = 0;
      for (let j = k; j < end; j++) { starts.push(at); at += lines[j].length + 1; }
      for (const [from, to] of digitSpans(lines.slice(k, end).join('\n'))) {
        starts.forEach((start, j) => {
          const span = [Math.max(from, start) - start, Math.min(to, start + lines[k + j].length) - start];
          const inner = /\d(?:.*\d)?/.exec(lines[k + j].slice(...span));
          if (span[0] < span[1] && inner !== null) hide(k + j, [span[0] + inner.index, span[0] + inner.index + inner[0].length]);
        });
      }
    }
    k = Math.max(end, k + 1);
  }

  // short pieces in a row, punctuation lines between them passed over, joined
  const hidePiece = (r) => hide(r.k, r.span);
  let run = [];
  const judge = () => {
    const odd = run.filter((r) => isOdd(r.piece));
    // (user1, user2, user3 are a list: one stem, numbered)
    const oneStem = new Set(odd.map((r) => r.piece.replace(/\d+$/, ''))).size === 1;
    if (odd.length >= 2 && !oneStem && !reads(joined(odd))) odd.forEach(hidePiece);
    if (joined(run).length >= GROUPED && !readsAsGroups(run.map((r) => groupOf(r.piece)))) run.forEach(hidePiece);
    const digits = run.filter((r) => /^\d+$/.test(r.piece) && (r.quote !== null || r.piece.length >= 3));
    if (digits.length >= 2 && joined(digits).length >= 16) digits.forEach(hidePiece);
    run = [];
  };
  for (const k of content) {
    const pieces = piecesOf(lines[k]);
    if (pieces.length === 0) { judge(); continue; }
    for (const p of pieces) run.push({k, ...p});
  }
  judge();
  return lines.map((line, k) => withoutSpans(line, spans[k]));
}

const FRAME = /^\s+at\s|^\s+File "/;
// node's assertion: the comparison it prints as the last line before its
// first stack frame (`1 !== 0`, `'a' != 'b'`), looked for within
// COMPARISON_WITHIN lines. A long message ends the block before it; it is
// then one of the block's values all the same, screened as they are.
const NODE_ASSERTION = /\bAssertionError \[ERR_ASSERTION\]/;
const NODE_COMPARISON = /^\s*\S.*\s!==?\s\S/;
const COMPARISON_MAX = 200;
const COMPARISON_WITHIN = 60;
// where another failure starts: the search for a comparison stops there
const NEXT_FAILURE = /\bAssertionError \[ERR_ASSERTION\]|^\s*[✖✔]\s/;
const INTERNAL_FRAME = /^\s*at\s(?:.*\()?node:internal\//;
// what starts something else: a test's result, another failure, a runner's
// section or header
const ENDS = /^\s*(?:[\u2714\u2713\u2716\u25cf\ufe63]|ok\s|not ok\b|--- (?:FAIL|PASS|SKIP):|=== (?:RUN|PAUSE|CONT|NAME)\s|---- |##\[|test .+ \.\.\. |failures:|note: |# (?:Subtest:|tests |suites |pass |fail )|\u2139\s|\d+ (?:passing|failing|pending)\b|(?:=+ )?\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|deselected)\b.* in [\d.]+s|FAILED \S+::|(?:PASS|FAIL)\s|(?:FAIL|ERROR):|_{3,}\s|={5,}|-{5,})|^\s*(?:[\w.]+\.)?AssertionError\b|^\S+:\d+: \w*Error\s*$/;
// a verdict that isn't kind 'assert': a Rust panic, testify's verdict, the
// first of pytest's E lines
const HEAD = /^\s*thread '.*'(?: \(\d+\))? panicked at |^\s*Error:\s+(?:Not equal|Should\b|Expected\b|Received\b)/;
const RUST_HEAD = /^\s*thread '.*'(?: \(\d+\))? panicked at .*:\d+:\d+:\s*$/;
const PYTEST_E = /^E\s{2,}\S/;
// pytest's summary of a failure, and a lint row: they say Assertion or Expected,
// and are no failed assertion of their own
const NO_VERDICT = /^\s*FAILED \S+::|^\s*\d+:\d+\s+(?:error|warning)\s/;
// Jest's and Vitest's code frame: numbered lines, one of them marked or with a
// line of its caret after it (numbered rows alone are a table)
const CODE_LINE = /^\s*>?\s*\d+\s*\|(?:\s|$)/;
const CODE_CARET = /^\s*\|[\s^~]*$/;
const CODE_MARK = /^\s*>\s*\d+\s*\||^\s*\|\s*[\^~]+\s*$/;
// what a value line looks like at a failure's own indent or left of it: a
// diff's, a bracket, a literal, a caret, a comparison, or a runner's word for
// one side
const VALUE_LINE = /^\s*(?:[-+?^]|@@|\.\.\.|[{}\])]|\[(?:\s|$|['"`\d\-[{\]]|[A-Z]\w*\])|E\s|(?:undefined|null|true|false|NaN|Infinity),?\s*$|-?\d[\d.,]*\s*$|\d+[.)]\s|['"`].*['"`],?\s*$)|^\s*(?:expected|actual|received|left|right|got|want(?:ed)?|diff(?:erence)?|messages?)\b[^:=]*[:=]|^\s*(?:First|Second) (?:differing|extra|list|sequence|tuple|dict)|\S !==? \S|\+ actual - expected|^\s*\u276f\s/i;
// brackets opened less closed, quoted text aside
const depthOf = (text) => {
  let n = 0;
  for (const c of text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '')) n += '{[('.includes(c) ? 1 : '}])'.includes(c) ? -1 : 0;
  return n;
};
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

// {texts, kinds, skipped} of one step; placeOf(index): the line's place in
// `lines`, or -1; isWhole(index): its text there is all of it; repeatsOf(index):
// how many its record stands for; tagOf, bodyOf: a line's parallel-runner tag and
// what follows it; cut: the line bound. -> {blocks: [{step, index, line?, repeats?,
// tag?, verdict, values, places, cut}], omittedBlocks}, or null when the step has no
// failed assertion with values.
function valueBlocks({texts, kinds, skipped, placeOf, isWhole, repeatsOf, tagOf: readTag, bodyOf: readBody, step, cut}) {
  const isKept = (i) => placeOf(i) >= 0;
  const used = new Set();
  const blocks = [];
  let omittedBlocks = 0;
  let lines = 0;
  let chars = 0;
  let full = false;
  let scanned = 0;
  // (each line's tag and body, read once)
  const tags = new Array(texts.length);
  const bodies = new Array(texts.length);
  const tagAt = (i) => (tags[i] === undefined ? (tags[i] = readTag(texts[i])) : tags[i]);
  const bodyAt = (i) => (bodies[i] === undefined ? (bodies[i] = readBody(texts[i])) : bodies[i]);
  const isVerdict = (i) => {
    const body = bodyAt(i);
    if (NO_VERDICT.test(body)) return false;
    if (kinds[i] === 'assert' || (kinds[i] === 'error' && HEAD.test(body))) return true;
    return PYTEST_E.test(body) && !(i > 0 && PYTEST_E.test(bodyAt(i - 1)));
  };
  const startsAnother = (j, body) => isVerdict(j) && STATES.test(body) && !CONTINUES.test(body);
  // the comparison node printed before the first frame after verdict i, or -1
  const comparisonAfter = (i, tag) => {
    for (let j = i + 1; j < texts.length && j <= i + COMPARISON_WITHIN; j++) {
      if (skipped[j] || (tag !== '' && tagAt(j) !== tag)) continue;
      if (NEXT_FAILURE.test(bodyFor(j, tag))) return -1;
      if (!FRAME.test(bodyFor(j, tag))) continue;
      let k = j - 1;
      while (k > i && (skipped[k] || (tag !== '' && tagAt(k) !== tag) || bodyFor(k, tag).trim() === '')) k--;
      const body = k > i ? bodyFor(k, tag) : '';
      return k > i && body.length <= COMPARISON_MAX && NODE_COMPARISON.test(body) && !FRAME.test(body) ? k : -1;
    }
    return -1;
  };
  const bodyFor = (j, tag) => (tag === '' ? texts[j] : bodyAt(j));
  // the lines after j of the same tag, up to the first that stops
  const follow = (j, tag, stops) => {
    const entries = [];
    for (let k = j + 1; k < texts.length && k - j <= SCAN && scanned < SCAN_ALL; k++, scanned++) {
      if (tag !== '' && tagAt(k) !== tag) continue;
      const body = bodyFor(k, tag);
      if (stops(body)) return {entries, stop: {j: k, body}};
      entries.push({j: k, body});
    }
    return {entries, stop: null};
  };
  // the diagnostic under a "not ok": its lines, and its values when it has some;
  // null when there is none, or it has neither values nor an end
  const diagnosticAt = (i, tag) => {
    const open = follow(i, tag, (body) => body.trim() !== '').stop;
    if (open === null || !YAML_OPEN.test(open.body)) return null;
    const indent = indentOf(open.body);
    const {entries, stop} = follow(open.j, tag, (body) => (YAML_CLOSE.test(body) && indentOf(body) === indent) || NOT_OK.test(body));
    const sections = sectionsOf(entries, indent);
    const closed = stop !== null && YAML_CLOSE.test(stop.body);
    if (!sections.has('expected') && !sections.has('actual')) return closed ? {verdict: i, lines: [], all: entries, more: false} : null;
    const message = sections.get('error') || [];
    const values = message.some((e) => DIFF.test(e.body)) ? [] : valueSections(sections);
    const keyKept = message.length > 0 && isKept(message[0].j);
    return {verdict: keyKept ? message[0].j : i, lines: [...message.slice(keyKept ? 1 : 0), ...values, ...(sections.get('stack') || []).slice(1, 2)], all: entries,
      more: !closed};
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
  // (a frame alone, in `lines` already, is no block)
  const add = (i, entries, isCut) => {
    if (!entries.some((e) => !isKept(e.j) || !FRAME.test(e.body))) return;
    const raw = entries.map((e) => e.body);
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
    const prefix = tagAt(i) === '' ? '' : texts[i].slice(0, texts[i].length - bodyAt(i).length);
    blocks.push({step, index: i, ...(prefix === '' ? {} : {tag: screenLine(prefix)}), ...(isKept(i) ? {line: placeOf(i)} : {}), ...(repeatsOf(i) > 1 ? {repeats: repeatsOf(i)} : {}), verdict, values, places: values.map((v, k) => (isKept(entries[k].j) && isWhole(entries[k].j) ? placeOf(entries[k].j) : -1)), cut: more});
  };
  for (let i = 0; i < texts.length; i++) {
    if (skipped[i] || used.has(i)) continue;
    const tag = tagAt(i);
    const diagnostic = NOT_OK.test(bodyFor(i, tag)) ? diagnosticAt(i, tag) : null;
    if (diagnostic !== null) {
      for (const e of diagnostic.all) used.add(e.j);
      if (!DIRECTIVE.test(texts[i])) add(diagnostic.verdict, diagnostic.lines, diagnostic.more);
      continue;
    }
    if (!isVerdict(i)) continue;
    if (scanned >= SCAN_ALL) { omittedBlocks++; continue; }
    const indent = indentOf(bodyAt(i));
    let depth = Math.max(0, depthOf(bodyAt(i)));
    let inCode = false;
    // (a Rust panic's message is the line after it, whatever it looks like)
    let message = RUST_HEAD.test(bodyAt(i));
    const raw = [];
    let more = false;
    let blank = 0;
    let seen = 0;
    let ended = false;
    let plain = true; // (nothing but the verdict before its first frame)
    let j = i + 1;
    for (; j < texts.length && seen < LOOK && j - i <= SCAN && scanned < SCAN_ALL; j++, scanned++) {
      if (skipped[j] || (tag !== '' && tagAt(j) !== tag)) continue;
      const body = bodyFor(j, tag);
      // (a code frame counts toward no bound)
      const isCode = CODE_LINE.test(body) || (inCode && CODE_CARET.test(body));
      inCode = isCode && (inCode || follow(j - 1, tag, (x) => x !== '' && !CODE_LINE.test(x) && !CODE_CARET.test(x)).entries.some((e) => CODE_MARK.test(e.body)));
      if (inCode) { used.add(j); continue; }
      seen++;
      if (body.trim() === '') {
        message = false;
        if (++blank >= 2) { ended = true; break; }
        continue;
      }
      blank = 0;
      if (INTERNAL_FRAME.test(body)) continue;
      const frame = FRAME.test(body);
      // (mocha's next failure sits left of this one's error; a list in a value does not)
      const nextNumbered = /^\s*\d+\) /.test(body) && indentOf(body) < indent;
      if (!frame && (nextNumbered || ENDS.test(body) || startsAnother(j, body))) { ended = true; break; }
      // (inside a bracket, or further in, or at the verdict's own indent when it has one, a line goes on)
      const inside = message || depth > 0 || indentOf(body) > indent || (indent > 0 && indentOf(body) === indent);
      if (!frame && !inside && !VALUE_LINE.test(body) && !CONTINUES.test(body)) { ended = true; break; }
      message = false;
      depth = Math.max(0, depth + depthOf(body));
      used.add(j);
      if (raw.length >= BOUNDS.PER_LINES) { more = true; ended = true; break; }
      raw.push({j, body: bodyFor(j, tag)});
      if (frame) {
        ended = true;
        const properties = plain ? propertiesAfter(j, tag) : null;
        if (properties !== null) {
          for (const e of properties.all) used.add(e.j);
          raw.push(...properties.lines);
          if (properties.lines.length > 0 && properties.more) more = true;
        }
        break;
      }
      plain = false;
    }
    // (a bound ended the look inside the block: there may be more)
    if (!ended && j < texts.length) more = true;
    const k = NODE_ASSERTION.test(bodyAt(i)) ? comparisonAfter(i, tag) : -1;
    if (k !== -1 && !raw.some((e) => e.j === k)) {
      used.add(k);
      // (first among the values, so the block's bounds never drop it; the
      // message's last line gives way when the block is full)
      raw.unshift({j: k, body: bodyFor(k, tag)});
      if (raw.length > BOUNDS.PER_LINES) { raw.splice(BOUNDS.PER_LINES); more = true; }
    }
    add(i, raw, more);
  }
  return blocks.length === 0 && omittedBlocks === 0 ? null : {blocks, omittedBlocks};
}

module.exports = {valueBlocks, screenBlock, screenLine, reads, BOUNDS, WITHHELD, LINE_WITHHELD};
