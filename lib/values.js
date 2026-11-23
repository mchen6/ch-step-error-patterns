'use strict';
// A failed assertion's expected and actual values, kept with it. A pure
// function of the lines it is given.
//
// They are `details`, beside `lines` and never in them: they don't count
// against maxLines and never reach the failure signature (a value changes from
// run to run; the failure does not).
//
// A block: the lines after a verdict, up to a blank pair, a stack frame (the
// first of the test's own is kept, as the failure's location), the next test
// or failure, or a bound. A runner's tag ends it only by being another's: with
// parallel runners, lines of other tags are passed over.
//
// These values are log text a pull request can write, and can hold what a
// test compared, so what leaves here is screened. The chain still redacts it.
// Screening fails closed: a value it can't call readable is withheld, in place,
// and says so:
//   - a line with a control, format or unassigned character: all of it;
//   - text in a script other than ASCII: that text;
//   - a standalone value (quoted, after a key, or a whole diff line) of six
//     characters or more, unless it reads as words, a literal, a plain number
//     or a CONSTANT_NAME; in a path, only its generated names;
//   - in the prose around it, a run that looks generated, and all of a run of
//     base64 characters that holds one;
//   - a word cut by the line bound: that word;
//   - across lines: a wrapped or split value (each line one bare value, as a
//     diff prints expected and actual) is judged joined, and beside a withheld
//     line only a literal, a number or a CONSTANT_NAME stays.
// What it cannot see: a value under six characters, a number under sixteen
// digits, a secret that reads as ordinary words, and a generated-looking word
// in prose that happens to read as one. It is a second line behind redaction.
const BOUNDS = Object.freeze({PER_LINES: 12, PER_CHARS: 1500, ALL_LINES: 40, ALL_CHARS: 4000});
const LOOK = 30;
const WITHHELD = '<withheld>';
const LINE_WITHHELD = '<value line withheld>';

const UNREADABLE = /\p{C}/u;
const RUN = /[^\s"'`()[\]{},;|<>]+/g;
const ATOM = /[A-Za-z0-9]+|[^\x00-\x7f\u2026]+/g;
const ASCII_ATOM = /^[A-Za-z0-9]+$/;
const BASE64_RUN = /^[A-Za-z0-9+/]{20,}={0,2}$/;
const WORDS = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g;

// The letter pairs that make up most English and code. A word is readable
// when enough of its pairs are these; a generated value's are few.
const COMMON = new Set(('th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur ca el ta la ns di fo ho pe ec pr no ct us ac ot il tr ly nc et ut ss so rs un lo wa ge ie wh ee wi em ad ol rt po we na ul ni ts mo ow pa im mi ai sh ir su id os iv ia am fi ci vi pl ig tu ev ld ry mp fe ab ty op ke ag ap').split(' '));
const ONE_WORD_SHARE = 0.6;
const PART_SHARE = 0.45;
// (names with a digit inside that are words to anyone who reads a CI log)
const KNOWN = new Set(['base64url', 'utf8mb4', 'sha256sum', 'sha512sum', 'md5sum', 'aarch64', 'amd64', 'arm64']);
const ACRONYM = /^[A-Z]{2,5}$/;
const LITERAL = /^(?:undefined|null|true|false|NaN|Infinity|-?\d{1,15}(?:\.\d+)?)$/;
const CONSTANT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function wordlike(word, share) {
  if (word.length < 4 || ACRONYM.test(word)) return true;
  const w = word.toLowerCase();
  if (!/[aeiouy]/.test(w)) return false;
  let hits = 0;
  for (let i = 0; i + 1 < w.length; i++) if (COMMON.has(w.slice(i, i + 2))) hits++;
  return hits / (w.length - 1) >= share;
}

// Prose and code around a value: does this run of letters and digits look
// generated? (lenient: ordinary names and words stay readable)
function looksGenerated(a) {
  if (a.length < 6 || KNOWN.has(a.toLowerCase())) return false;
  if (/^\d+$/.test(a)) return a.length >= 16;
  if (/^[0-9a-f]+$/i.test(a) && (/\d/.test(a) ? a.length >= 8 : a.length >= 12)) return true;
  const digits = (a.match(/\d/g) || []).length;
  if (a.length >= 8 && digits * 2 > a.length) return true;
  const numbers = (a.match(/\d+/g) || []).length;
  if (numbers >= 2 || (numbers === 1 && /[A-Za-z]\d/.test(a) && /\d[A-Za-z]/.test(a))) return true;
  const words = a.match(WORDS) || [];
  if (words.length >= 4 && a.length / words.length < 3) return true;
  if (a.length >= 24 && words.length <= 1) return true;
  if (a.length >= 16 && /[a-z]/.test(a) && /[A-Z]/.test(a) && words.some((w) => /[a-z]/.test(w) && !/[aeiouy]/i.test(w))) return true;
  const letters = a.replace(/\d/g, '');
  return letters.length >= 10 && (letters.match(/[aeiou]/gi) || []).length / letters.length < 0.2;
}

// A standalone value (quoted, after a key, or a whole diff line), where a
// secret would sit: shown only when it can be called readable. Fails closed.
function readablePart(part, inParts) {
  if (part.length < 4 || /^\d{1,15}$/.test(part) || KNOWN.has(part.toLowerCase())) return true;
  if (looksGenerated(part)) return false;
  const numbers = part.match(/\d+/g) || [];
  if (numbers.length > 1 || (numbers.length === 1 && (!/\d$/.test(part) || numbers[0].length > 4))) return false;
  const words = part.replace(/\d+$/, '').match(WORDS) || [];
  if (words.length >= 3 && words.filter((w) => w.length <= 2).length * 2 > words.length) return false;
  const share = inParts || words.length > 1 ? PART_SHARE : ONE_WORD_SHARE;
  // (in a name of several words, a short word needs only a vowel)
  return words.every((w) => ((inParts || words.length > 1) && w.length < 6 ? /[aeiouy]/i.test(w) || ACRONYM.test(w) : wordlike(w, share)));
}
function readableValue(v) {
  if (v.length < 6 || LITERAL.test(v) || CONSTANT.test(v)) return true;
  if (!/^[\x21-\x7e]+$/.test(v)) return false;
  const parts = v.split(/[-_.:@]+/).filter((x) => x !== '');
  return parts.length > 0 && parts.every((x) => /^[A-Za-z0-9]+$/.test(x) && readablePart(x, parts.length > 1));
}

const screenAtom = (a) => (!ASCII_ATOM.test(a) || looksGenerated(a) ? WITHHELD : a);

function screenRun(run) {
  if (BASE64_RUN.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run)) {
    const atoms = run.match(ATOM) || [];
    // (a + inside, or the padding at the end: nothing but base64 reads so)
    if (/.\+|=$/.test(run)) return WITHHELD;
    const opaqueChars = atoms.filter(looksGenerated).reduce((n, a) => n + a.length, 0);
    // (a path holds a generated name among words; a key is mostly that)
    if (opaqueChars * 2 >= run.length) return WITHHELD;
    if (!run.includes('/') && /\d/.test(run)) return WITHHELD;
  }
  return run.replace(ATOM, screenAtom);
}

// A standalone value: kept, withheld, or, for a path, its generated names
// withheld.
const screenValue = (v) => {
  if (/[/\\]/.test(v)) return screenRun(v);
  return readableValue(v) ? v : WITHHELD;
};
// a quoted string, matched whole so a closing quote never opens the next one
// (an apostrophe inside a word opens nothing). A value with no space is judged;
// a JSON key (a colon follows) and a sentence are left to the prose rules.
const QUOTED = /(?<![A-Za-z0-9])(['"`])((?:\\.|(?!\1)[^\\])*)\1(\s*:)?/g;
// key: value or key=value, the value ending the line or its item
const KEYED = /(^|[\s{,(])([A-Za-z_][\w-]*)(\s*[:=]\s*)([^\s'"`,;(){}[\]<>]+)(?=\s*(?:[,;)}\]]|$))/g;
const WHOLE = /^(\s*(?:E\s+)?[-+]?\s*)([^\s'"`]+)(,?\s*)$/;

// -> the line, with what can't be called readable withheld.
function screenLine(text) {
  if (UNREADABLE.test(text.replace(/\t/g, ' '))) return LINE_WITHHELD;
  const standalone = text
    .replace(QUOTED, (m, q, v, key) => (key !== undefined || v === '' || /\s/.test(v) ? m : `${q}${screenValue(v)}${q}`))
    .replace(KEYED, (m, pre, key, sep, v) => `${pre}${key}${sep}${screenValue(v)}`)
    .replace(WHOLE, (m, pre, v, post) => (v.startsWith('<') ? m : `${pre}${screenValue(v)}${post}`));
  return standalone.replace(RUN, screenRun).replace(/[A-Za-z0-9]+\u2026$/, `${WITHHELD}\u2026`);
}

// A line that is one bare value, as a diff prints it: the value, else null.
const BARE = /^\s*(?:E\s+)?[-+]?\s*['"`]?([A-Za-z0-9+/=_-]{2,})['"`]?,?\s*$/;
const bareOf = (line) => {
  const m = BARE.exec(line);
  return m == null ? null : m[1];
};
const KEEPS_BESIDE = /^(?:undefined|null|true|false|NaN|Infinity|-?\d{1,4}(?:\.\d+)?|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/;
const withheldLine = (line, value) => line.replace(value, WITHHELD);

// -> the lines of one block, each screened, and values split over lines judged
// together.
function screenBlock(lines) {
  const out = lines.map(screenLine);
  for (let i = 0; i < lines.length;) {
    if (bareOf(lines[i]) == null) { i++; continue; }
    let j = i;
    while (j < lines.length && bareOf(lines[j]) != null) j++;
    const members = [];
    for (let k = i; k < j; k++) members.push({k, value: bareOf(lines[k]), hidden: out[k] !== lines[k]});
    // beside a withheld line, only what can't be a piece of a value stays
    members.forEach((m, n) => {
      const near = [members[n - 1], members[n + 1]].some((x) => x !== undefined && x.hidden);
      if (!m.hidden && near && !KEEPS_BESIDE.test(m.value)) out[m.k] = withheldLine(lines[m.k], m.value);
    });
    // the rest, joined: short pieces that read as one generated value (a
    // longer one was judged alone; two ids compared are never halves of one)
    const open = members.filter((m) => m.value.length < 6 && !KEEPS_BESIDE.test(m.value) && !/^\d+$/.test(m.value) && out[m.k] === lines[m.k]);
    const joined = open.map((m) => m.value).join('');
    if (open.length >= 2 && screenLine(joined) !== joined) {
      for (const m of open) out[m.k] = withheldLine(lines[m.k], m.value);
    }
    i = j;
  }
  return out;
}

const FRAME = /^\s+at\s|^\s+File "/;
const INTERNAL_FRAME = /^\s*at\s(?:.*\()?node:internal\//;
// what starts something else: a test's result, another failure, a runner's
// section
const ENDS = /^\s*(?:[\u2714\u2713\u2716\u25cf\ufe63]|ok\s|not ok\b|\d+\) |--- |=== |---- |##\[|test .+ \.\.\. |failures:|note: )|\bAssertionError\b/;
// a verdict that isn't kind 'assert': a Rust panic, testify's verdict, the
// first of pytest's E lines
const HEAD = /^\s*thread '.*'(?: \(\d+\))? panicked at |^\s*Error:\s+(?:Not equal|Should\b|Expected\b|Received\b)/;
const PYTEST_E = /^E\s{2,}\S/;

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
  for (let i = 0; i < texts.length; i++) {
    if (skipped[i] || used.has(i) || !isVerdict(i)) continue;
    const tag = tagOf(texts[i]);
    const raw = [];
    let more = false;
    let blank = 0;
    let seen = 0;
    let j = i + 1;
    for (; j < texts.length && seen < LOOK; j++) {
      if (skipped[j] || (tag !== '' && tagOf(texts[j]) !== tag)) continue;
      seen++;
      const body = bodyOf(texts[j]);
      if (body.trim() === '') {
        if (++blank >= 2) break;
        continue;
      }
      blank = 0;
      if (INTERNAL_FRAME.test(body)) continue;
      const frame = FRAME.test(body);
      if (!frame && ENDS.test(body)) break;
      used.add(j);
      if (!isKept(j)) {
        if (raw.length >= BOUNDS.PER_LINES) { more = true; break; }
        raw.push(tag === '' ? texts[j] : body);
      }
      if (frame) break;
    }
    // (the look ran out inside the block: there may be more)
    if (seen >= LOOK && j < texts.length) more = true;
    if (raw.length === 0) continue;
    if (full) { omittedBlocks++; continue; }
    const values = [];
    let size = 0;
    for (const line of screenBlock(raw)) {
      const text = cut(line);
      if (size + text.length > BOUNDS.PER_CHARS) { more = true; break; }
      values.push(text);
      size += text.length;
      if (text.endsWith('\u2026')) more = true;
    }
    if (values.length === 0 || lines + values.length > BOUNDS.ALL_LINES || chars + size > BOUNDS.ALL_CHARS) {
      full = true;
      omittedBlocks++;
      continue;
    }
    lines += values.length;
    chars += size;
    blocks.push({step, index: i, verdict: cut(screenLine(texts[i])), values, cut: more});
  }
  return blocks.length === 0 && omittedBlocks === 0 ? null : {blocks, omittedBlocks};
}

module.exports = {valueBlocks, screenBlock, screenLine, readableValue, looksGenerated, BOUNDS, WITHHELD, LINE_WITHHELD};
