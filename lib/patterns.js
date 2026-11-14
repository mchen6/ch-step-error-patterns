'use strict';
// The few lines that matter from one failed job, out of ch-step-log-clean's
// steps. A pure function of its input.
//
// Kinds, in priority order:
//   exit    "Process completed with exit code N", N > 0: the line that marks
//           the failing step;
//   error   a ##[error] line, an error or exception name (TypeError,
//           IllegalStateException), the word "error" where tools print it as
//           a verdict (at the start of a line, "npm error", "error:",
//           "error[E0308]:", "error TS2304", ESLint's "3:5  error", tsc's
//           "Found 2 errors"; not console.error or a file
//           called error.test.js), "ERROR", FAIL/FAILED, panic:, fatal:, TAP's
//           "not ok" (not with # SKIP or # TODO), node --test's ✖, Jest's ●;
//   assert  one of those that says Assertion or Expected, or "expected …"
//           with to, but, got, received or actual (not tsc's "';' expected"),
//           and Jest's expect(…), Expected: and Received: lines;
//   stack   a stack frame (JavaScript "  at …", Python '  File "…"'), never an
//           error itself whatever it names: the first two within ten lines
//           after an error or assertion, and for a Python traceback its head
//           and its two innermost frames (Python prints the raising frame
//           last);
//   tail    when fewer than five lines matched: the last fifteen lines of the
//           failing step (or of the last step that ran a command).
// failingStep comes from the jobs API's step conclusions when they are given
// and can be matched to the log's steps: the first step whose conclusion is
// failure (a continue-on-error step's conclusion is success), matched by name,
// else by position among the steps that ran commands. Otherwise from the log:
// the step holding the last exit line, else the last step with an error line,
// else null.

// JSON log records and other noise (rules 2; dogfood of run 43497750749,
// the reviewer, 2026-11-13), before any line is classified:
//   - a JSON log record (bunyan, pino: an object with a level, a number or
//     a name) below warn (40) is dropped, from the matches and the tail; at
//     warn or above it is its `e` (or `err`), its message when that is an
//     error object, else its `msg`; at error (50) or above it is an error
//     whatever it says;
//   - records in one step that are the same apart from pid, time and the
//     like (the same level and text) are one line, the first, whose
//     `repeats` says how many there were (never in its text: the failure
//     signature is made from the text);
//   - a record is an object with a level, a time and its text in msg,
//     message, e or err (bunyan, pino); any other is an ordinary line;
//   - a stack frame in Node's own code (node:internal) is skipped, and does
//     not use up the frames an error gets;
//   - JSON embedded in a picked line is cut to 200 characters.
// `rules` names this version in the output: the failure signature is made
// from these lines, so a scenario that caches signatures can tell an
// extraction made by other rules.
const RULES = 2;
const LEVELS = {trace: 10, debug: 20, info: 30, warn: 40, warning: 40, error: 50, fatal: 60};
const WARN = 40;
const ERROR_LEVEL = 50;
const INTERNAL_FRAME = /^\s*at\s(?:.*\()?node:internal\//;
// Every line at most LINE_MAX characters, cut with … (the reviewer,
// 2026-11-13): in what is taken in, before any pattern runs, and in what is
// given back. ch-step-redact gives back lines of this bound (masked, then
// cut), from ch-step-log-clean's lines of at most 20000.
const LINE_MAX = 500;
// A step's name given back at most NAME_MAX characters (ch-step-log-clean
// cuts the names it reads to the same bound).
const NAME_MAX = 200;
const cutName = (t) => cutTo(t, NAME_MAX);
// Cut with …, never between the halves of a surrogate pair.
const cutLine = (t) => cutTo(t, LINE_MAX);
function cutTo(t, max) {
  if (t.length <= max) return t;
  let end = max - 1;
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${t.slice(0, end)}…`;
}
// Mocha's numbered failures, in its summary: "  1) suite title", the test's
// title on the lines below, then its error ("TypeError: …"). The title and
// the error are paired, and ranked above the generic matches, so a test's
// failure survives a noisy log.
// The title's lines and the error are indented deeper than the title, and
// the error line starts with an error's name; anything else ends the look.
const MOCHA_TITLE = /^(\s+)(\d+)\) \S/;
const MOCHA_LOOKAHEAD = 8;
const MOCHA_STOP = /^\s*(?:[✔✓]|\d+\) )/;
const MOCHA_ERROR = /^\s*(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error)\b/;
const indentOf = (t) => t.length - t.trimStart().length;
const EMBEDDED_JSON = /\{\\?"/;
const JSON_KEEP = 200;

// A record's text is its first non-empty line: an `e` may be a whole stack.
const textOf = (v) => {
  if (typeof v !== 'string') return null;
  const line = v.split(/\r?\n/).find((l) => l.trim() !== '');
  return line === undefined ? null : line;
};

// The top-level members of a JSON object's text that may be cut short:
// {key: value} for a string (as far as it goes), a number, or, `depth`
// levels down, an object's own members; anything else is skipped whole,
// nested members included. Linear in the text.
const ESCAPES = {n: '\n', t: '\t', r: '\r', b: '\b', f: '\f'};
function membersOf(t, start, depth) {
  const out = {};
  let i = start;
  if (t[i] !== '{') return out;
  i++;
  const readString = () => {   // at a '"': -> {s, done}
    let s = '';
    i++;
    while (i < t.length) {
      const c = t[i];
      if (c === '"') { i++; return {s, done: true}; }
      if (c === '\\') {
        const n = t[i + 1];
        if (n === undefined) break;
        if (n === 'u') {
          const hex = t.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) { i = t.length; break; }
          s += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        s += ESCAPES[n] !== undefined ? ESCAPES[n] : n;
        i += 2;
        continue;
      }
      s += c;
      i++;
    }
    return {s, done: false};
  };
  const skipValue = () => {
    let level = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === '"') { readString(); if (level === 0) return; continue; }
      if (c === '{' || c === '[') level++;
      else if (c === '}' || c === ']') {
        if (level === 0) return;
        level--;
        if (level === 0) { i++; return; }
      } else if (level === 0 && c === ',') return;
      i++;
    }
  };
  const blank = /\s/;
  while (i < t.length) {
    while (i < t.length && (blank.test(t[i]) || t[i] === ',')) i++;
    if (t[i] !== '"') break;
    const key = readString();
    if (!key.done) break;
    while (i < t.length && blank.test(t[i])) i++;
    if (t[i] !== ':') break;
    i++;
    while (i < t.length && blank.test(t[i])) i++;
    const c = t[i];
    if (c === '"') {
      const v = readString();
      out[key.s] = v.s;
      if (!v.done) break;
    } else if (c !== undefined && /[-\d]/.test(c)) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(t.slice(i, i + 40));
      if (m == null) break;
      out[key.s] = Number(m[0]);
      i += m[0].length;
    } else if (c === '{' && depth > 0) {
      out[key.s] = membersOf(t, i, depth - 1);
      skipValue();
    } else {
      skipValue();
    }
  }
  return out;
}

// A record cut by the line bound (it ends with …) is no longer JSON: its
// top-level members, read as far as they go, still name the level and its
// text (the same keys and order as a whole record's). -> the record as far
// as it goes, or null.
function partialRecord(t) {
  if (!t.endsWith('…')) return null;
  const o = membersOf(t, 0, 1);
  if (o.level === undefined || !['time', 'pid', 'hostname'].some((k) => Object.hasOwn(o, k))) return null;
  return {...o, time: o.time !== undefined ? o.time : true};
}

// -> null for a line that is not a JSON log record; {drop: true} for one
// below warn or with no text; else {text, error, key}.
function logRecord(line) {
  const t = line.trim();
  if (!t.startsWith('{') || !(t.endsWith('}') || t.endsWith('…'))) return null;
  let o;
  try { o = JSON.parse(t); } catch { o = partialRecord(t); }
  if (o == null || typeof o !== 'object' || Array.isArray(o)) return null;
  const level = typeof o.level === 'string' ? LEVELS[o.level.toLowerCase()] : o.level;
  if (!Number.isFinite(level)) return null;
  // A logger's record has a time and its text where loggers put it; any
  // other object with a level (a test's result, a config dump) is a line.
  const e = o.e != null ? o.e : o.err;
  if (o.time == null || !['msg', 'message', 'e', 'err'].some((k) => Object.hasOwn(o, k))) return null;
  if (level < WARN) return {drop: true};
  const text = textOf(e) || (e != null && typeof e === 'object' ? textOf(e.message) : null) || textOf(o.msg) || textOf(o.message);
  if (text == null) return {drop: true};
  return {text, error: level >= ERROR_LEVEL, key: `${level >= ERROR_LEVEL}:${text}`};
}

// One step's lines: {text, error, count}, a JSON record reduced to its
// text, or null for a line left out (a record dropped, or a repeat within
// the step, counted on its first). The count is not in the text: the failure
// signature is made from the text, and must not change with how many
// processes logged the same record.
function normalise(lines) {
  const first = new Map(); // key -> the first record's entry
  return lines.map((line) => {
    const r = logRecord(line);
    if (r == null) return {text: line, error: false, count: 1};
    if (r.drop === true) return null;
    const seen = first.get(r.key);
    if (seen != null) { seen.count++; return null; }
    const entry = {text: r.text, error: r.error, count: 1};
    first.set(r.key, entry);
    return entry;
  });
}

// A picked line with JSON in it: the JSON cut to JSON_KEEP characters.
function cutJson(text) {
  const at = text.search(EMBEDDED_JSON);
  if (at === -1 || text.length - at <= JSON_KEEP) return text;
  // A plain …: a count of what was cut would change the failure signature
  // whenever the JSON's length did.
  return `${text.slice(0, at + JSON_KEEP)}…`;
}

const API_SETUP = /^(?:Set up job|Complete job)$|^Post /;
const isLogCommandStep = (name) => name !== '(top)' && name !== 'Post job cleanup';

// -> the index in steps of the failed step the conclusions name, or null.
function failedFromConclusions(steps, stepConclusions) {
  if (!Array.isArray(stepConclusions)) return null;
  const ran = stepConclusions.filter((c) => c.conclusion !== 'skipped' && !API_SETUP.test(c.name));
  const k = ran.findIndex((c) => c.conclusion === 'failure');
  if (k === -1) return null;
  // By name: the failed step is the j-th of the steps with its name.
  const j = ran.slice(0, k).filter((c) => c.name === ran[k].name).length;
  const named = steps.map((s, i) => i).filter((i) => steps[i].name === ran[k].name);
  if (named.length > j) return named[j];
  const logSteps = steps.map((s, i) => i).filter((i) => isLogCommandStep(steps[i].name));
  return logSteps.length === ran.length ? logSteps[k] : null;
}

const EXIT = /Process completed with exit code [1-9]\d*/;
const ERROR = /^##\[error\]|\b(?:[A-Z][A-Za-z]*)?(?:Error|Exception)\b|^\s*(?:npm\s+)?error\b|(?<!\.)\berror(?:\[\w+\])?:|\berror\s+[A-Z]+\d+|^\s*\d+:\d+\s+error\b|\bFound \d+ errors?\b|\bERROR\b|\bFAIL(?:ED)?\b|\b(?:panic|fatal):|^\s*not ok\b|^\s*[✖●]/;
const JEST_ASSERT = /^\s*expect\(|^\s*(?:Expected|Received)(?: [\w ]+)?:/;
const TAP_DIRECTIVE = /^\s*not ok\b.*#\s*(?:SKIP|TODO)\b/i;
const ASSERT = /Assertion|\bExpected\b|\bexpected\b(?=.*\b(?:to|but|got|received|actual)\b)/;
const TRACEBACK = /^\s*Traceback \(most recent call last\):/;
const FRAME = /^\s+at\s|^\s+File "/;
const FRAME_WINDOW = 10;
const FRAMES_PER_ERROR = 2;
const TAIL_BELOW = 5;
const TAIL_LINES = 15;
const TRACEBACK_MAX = 200;
// Over maxLines: the exit line first, then errors, assertions and frames
// together in log order (a frame explains the error beside it), the tail last.
const RANK = {exit: 0, failure: 0.5, error: 1, assert: 1, stack: 1, tail: 2};

// A test runner's passing line (mocha's and node --test's ✔, ✓): what it
// names is a test that passed, whatever it says ("✔ retries (was:
// TypeError)").
const PASSED = /^\s*[✔✓]/;

function classify(text) {
  if (EXIT.test(text)) return 'exit';
  if (FRAME.test(text) || TAP_DIRECTIVE.test(text) || PASSED.test(text)) return null;
  if (JEST_ASSERT.test(text)) return 'assert';
  if (ERROR.test(text)) return ASSERT.test(text) ? 'assert' : 'error';
  if (TRACEBACK.test(text)) return 'stack';
  return null;
}

// -> {failingStep, lines: [{step, index, text, kind}], truncated}, the lines
// in log order. Over maxLines, the failing step's lines are kept first, by kind
// (exit, then errors and assertions, then frames, then the tail), earlier
// before later.
function extractErrors(steps, maxLines, stepConclusions) {
  const normalised = steps.map((step) => normalise(step.lines.map(cutLine)));
  const found = []; // {s, index, text, kind, count}
  steps.forEach((step, s) => {
    const entries = normalised[s];
    // A line left out or a frame in Node's own code is passed over: it ends
    // no traceback and counts toward no window.
    const skipped = entries.map((e) => e == null || INTERNAL_FRAME.test(e.text));
    const texts = entries.map((e) => (e == null ? '' : e.text));
    const kinds = entries.map((e, index) => {
      if (skipped[index]) return null;
      if (e.error) return ASSERT.test(e.text) ? 'assert' : 'error';
      return classify(e.text);
    });
    // Mocha's numbered failures: the title, its lines and its error, paired.
    const failure = new Map(); // index -> mocha's failure number
    texts.forEach((text, index) => {
      const m = skipped[index] ? null : MOCHA_TITLE.exec(text);
      if (m == null) return;
      const titleIndent = m[1].length;
      const group = [index];
      for (let j = index + 1, seen = 0; j < texts.length && seen < MOCHA_LOOKAHEAD; j++) {
        if (skipped[j] || texts[j].trim() === '') continue;
        seen++;
        if (MOCHA_STOP.test(texts[j]) || indentOf(texts[j]) <= titleIndent) break;
        if ((kinds[j] === 'error' || kinds[j] === 'assert') && MOCHA_ERROR.test(texts[j])) {
          for (const k of [...group, j]) failure.set(k, Number(m[2]));
          for (const k of group) if (kinds[k] === null) kinds[k] = 'error';
          break;
        }
        group.push(j);
      }
    });
    texts.forEach((text, index) => {
      if (kinds[index] === 'error' || kinds[index] === 'assert') {
        let frames = 0;
        let seen = 0;
        for (let j = index + 1; j < texts.length && seen < FRAME_WINDOW && frames < FRAMES_PER_ERROR; j++) {
          if (skipped[j]) continue;
          seen++;
          if (FRAME.test(texts[j])) {
            frames++;
            if (kinds[j] === null) kinds[j] = 'frame';
          }
        }
      } else if (kinds[index] === 'stack' && TRACEBACK.test(text)) {
        // The traceback's indented body, up to its exception line.
        const frames = [];
        let seen = 0;
        for (let j = index + 1; j < texts.length && seen < TRACEBACK_MAX; j++) {
          if (skipped[j]) continue;
          if (!/^\s/.test(texts[j])) break;
          seen++;
          if (FRAME.test(texts[j])) frames.push(j);
        }
        for (const j of frames.slice(-FRAMES_PER_ERROR)) if (kinds[j] === null) kinds[j] = 'frame';
      }
    });
    kinds.forEach((kind, index) => {
      if (kind !== null) found.push({s, index, text: texts[index], kind: kind === 'frame' ? 'stack' : kind, count: entries[index].count, failure: failure.get(index)});
    });
  });

  // The last exit line: an earlier one is a continue-on-error step's.
  const exitAt = found.findLast((l) => l.kind === 'exit');
  const lastError = found.findLast((l) => l.kind === 'error' || l.kind === 'assert');
  const fromApi = failedFromConclusions(steps, stepConclusions);
  const failing = fromApi !== null ? fromApi : exitAt ? exitAt.s : lastError ? lastError.s : null;

  if (found.length < TAIL_BELOW) {
    let t = failing;
    if (t === null) {
      for (let s = steps.length - 1; s >= 0 && t === null; s--) if (/^Run /.test(steps[s].name)) t = s;
    }
    if (t !== null) {
      const taken = new Set(found.filter((l) => l.s === t).map((l) => l.index));
      const entries = normalised[t];
      for (let index = Math.max(0, entries.length - TAIL_LINES); index < entries.length; index++) {
        if (!taken.has(index) && entries[index] != null && !INTERNAL_FRAME.test(entries[index].text)) found.push({s: t, index, text: entries[index].text, kind: 'tail', count: entries[index].count});
      }
    }
  }

  const byLog = (a, b) => (a.s - b.s) || (a.index - b.index);
  const rankOf = (l) => (l.failure != null && l.kind !== 'stack' ? RANK.failure : RANK[l.kind]);
  const byKeep = (a, b) => ((b.s === failing) - (a.s === failing)) || (rankOf(a) - rankOf(b)) || byLog(a, b);
  const kept = [...found].sort(byKeep).slice(0, maxLines).sort(byLog);
  return {
    failingStep: failing === null ? null : cutName(steps[failing].name),
    lines: kept.map((l) => ({step: cutName(steps[l.s].name), index: l.index, text: cutLine(cutJson(l.text)), kind: l.kind,
      ...(l.count > 1 ? {repeats: l.count} : {}), ...(l.failure != null ? {failure: l.failure} : {})})),
    truncated: found.length > maxLines,
    rules: RULES
  };
}

module.exports = {extractErrors, RULES, LINE_MAX};
