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
//           called error.test.js), "ERROR", FAIL/FAILED, panic:, a Rust
//           thread's "panicked at", fatal:, TAP's "not ok" (not with # SKIP
//           or # TODO), node --test's ✖, Jest's ●; never a passing test's
//           line, an error's name in a file name or a coverage row, npm's
//           warnings or a count of zero errors (PASSED, below);
//   assert  one of those that says Assertion or Expected, or "expected …"
//           with to, but, got, received or actual (not tsc's "';' expected"),
//           Jest's expect(…), Expected: and Received: lines, and the
//           details below (markDetails): a failed go test's indented lines,
//           a Rust panic's message, the lines indented under a FAIL naming a
//           file and line (at most three), and node's comparison printed
//           before an assertion's first frame past its values' reach;
//   stack   a stack frame (JavaScript "  at …", Python '  File "…"'), never an
//           error itself whatever it names: the first two within ten lines
//           after an error or assertion, and for a Python traceback its head
//           and its two innermost frames (Python prints the raising frame
//           last); ESLint's file line above an error row, rustc's --> line;
//   tail    when fewer than five of the failing step's lines matched (other
//           steps' matches do not count): the last fifteen lines of the
//           failing step (or of the last step that ran a command).
// failingStep comes from the jobs API's step conclusions when they are given
// and can be matched to the log's steps: the first step whose conclusion is
// failure (a continue-on-error step's conclusion is success), matched by name,
// else by position among the steps that ran commands. Otherwise from the log:
// the step holding the last exit line, else the last step with an error line,
// else null.

const {valueBlocks, BOUNDS} = require('./values');

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
// (rules 3: passing lines, the details kept beside a verdict, the tail decided
// by the failing step's own matches -- the final pass on the packs)
// (rules 4: a test runner's marks read through a parallel runner's tag, a
// skipped test's mark, and Rust's panic line with a thread id)
const RULES = 4;
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
const ERROR = /^##\[error\]|\b(?:[A-Z][A-Za-z]*)?(?:Error|Exception)\b(?!\.\w|\s*\|)|^\s*thread '.*'(?: \(\d+\))? panicked at |^\s*(?:npm\s+)?error\b|^\s*npm\s+ERR!|(?<!\.)\berror(?:\[\w+\])?:|\berror\s+[A-Z]+\d+|^\s*\d+:\d+\s+error\b|\bFound [1-9]\d* errors?\b|\bERROR\b|\bFAIL(?:ED)?\b|\b(?:panic|fatal):|^\s*not ok\b|^\s*[✖●]/;
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

// A test runner's passing line (mocha's and node --test's ✔, ✓; go test's
// === RUN and --- PASS:; Jest's PASS; go's and TAP's ok; pytest -v's trailing
// PASSED): what it names is a test that passed, whatever it says ("✔ retries
// (was: TypeError)", "--- PASS: TestParseError"). An error's name followed by
// a file extension or a table bar is a file or a coverage row (ERROR's
// lookahead); npm's warnings (warn, npm 9's WARN) and a bare count of zero
// errors (NOT_AN_ERROR) are no errors either, nor is tsc's "Found 0 errors"
// (ERROR counts from 1) (the final pass on the packs, A5). PASSED also takes
// cargo's and unittest's test lines ending "... ok"; its pytest forms are
// pytest's own (a node id, ::, then PASSED; xdist's [gwN] [ N%] PASSED), so a
// summary ending in PASSED is still read. npm's own lines (npm error, npm 6-9's
// npm ERR!) are errors but never keep the failing step's tail out (TAIL_BELOW
// counts none of them): npm's closing block of 5-10 lines follows a script's
// own message, often one nothing matches; the line naming npm's log file
// (a timestamp in its name) is none.
const PASSED = /^\s*(?:[✔✓\ufe63]|=== (?:RUN|PAUSE|CONT|NAME)\s|--- (?:PASS|SKIP):|PASS\s|ok\s)|^\S+::.*\sPASSED(?:\s+\[\s*\d+(?:%|\/\d+)\])?\s*$|^\s*(?:\[gw\d+\]\s+)?(?:\[\s*\d+(?:%|\/\d+)\]\s+)?PASSED\s+\S+::|^\s*test .+ \.\.\. ok\s*$|^\S+ \([\w.]+\) \.\.\. ok\s*$/;
const NOT_AN_ERROR = /^\s*npm\s+warn\b|^\s*0\s+Errors?(?:\(s\))?\s*$|^\s*npm\s+(?:error|ERR!)\s+(?:A complete log of this run\b|\S*[\\/]_logs[\\/])/i;
const NPM_LINE = /^\s*npm\s+(?:error|ERR!)/i;
// (unittest -v with a docstring: the test's id, then the docstring's first
// line ending "... ok")
const UNITTEST_ID = /^\S+ \([\w.]+\)\s*$/;
const ENDS_OK = /\s\.\.\.\s+ok\s*$/;
// (A8) The line that says what failed, kept beside its verdict however many
// verdicts the step has:
//   - go test: a failed test's indented lines, at most five each: in go test
//     -v those after its === RUN, === CONT or === NAME line (the test whose
//     output follows; with t.Parallel the tests' lines interleave), and
//     those right after its --- FAIL: ('assert');
//   - ESLint stylish: the file line above an error row ('stack');
//   - rustc: the --> line within three lines after an error ('stack');
//   - a Rust panic ('error', "thread '…' panicked at"): its message, the lines
//     after it up to a blank line, a note:, a stack backtrace: or the next
//     test's ---- header, at most five ('assert').
// A verdict is an 'error' or an 'assert' line (ESLint's "Expected
// indentation" row is one).
const GO_RUN = /^\s*=== (RUN|CONT|NAME)\s+(\S+)/;
const GO_END = /^\s*--- (FAIL|PASS|SKIP): (\S+)/;
const GO_DETAIL = /^\s{4,}\S/;
const GO_MARK = /^\s*(?:===|---) /;
const ESLINT_ROW = /^\s*\d+:\d+\s+(?:error|warning)\b/;
const ESLINT_ERROR_ROW = /^\s*\d+:\d+\s+error\b/;
const FILE_LINE = /^\S.*\.[A-Za-z0-9]{1,10}$/;
const RUSTC_ERROR = /^error(?:\[\w+\])?:/;
const RUSTC_AT = /^\s*--> \S/;
const RUSTC_AT_WITHIN = 3;
const PANIC = /^\s*thread '.*'(?: \(\d+\))? panicked at /;
const PANIC_END = /^\s*$|^note: |^---- |^stack backtrace:/;
const DETAIL_MAX = 5;
// A FAIL naming a file and line (`FAIL docs/x.md:339`): the lines indented
// under it are its message, at most FAIL_DETAIL_MAX of them (jest's
// `FAIL src/x.test.ts` names no line, go's and pytest's forms differ: none of
// them is this)
const FAIL_FILE_LINE = /^(\s*)FAIL\s+\S+:\d+\s*$/;
const FAIL_DETAIL_MAX = 3;
// node's assertion: the comparison it prints as the last line before the
// first stack frame (`1 !== 0`, `'a' != 'b'`), looked for within
// ASSERT_FRAME_WITHIN lines, and kept only past what the assertion's value
// block reaches (BOUNDS.PER_LINES): near it, the values show it already; a
// long message pushes it out of their reach
const NODE_ASSERTION = /\bAssertionError\b/;
const NODE_COMPARISON = /^\s*\S.*\s!==?\s\S/;
const NODE_COMPARISON_MAX = 200;
const ASSERT_FRAME_WITHIN = 60;

// (A8) Marks, in one step, the lines that say what failed beside a verdict
// (above). Linear: each line is looked at a bounded number of times.
function markDetails(texts, kinds, skipped) {
  const mark = (j, kind) => { if (kinds[j] === null) kinds[j] = kind; };
  const verdict = (i) => kinds[i] === 'error' || kinds[i] === 'assert';
  const goDetails = new Map(); // go test name -> its detail lines so far
  let goCurrent = null;        // the test whose output follows
  let fileLine = -1;           // ESLint: the file line the rows below belong to
  for (let i = 0; i < texts.length; i++) {
    if (skipped[i]) continue;
    const text = texts[i];
    const run = GO_RUN.exec(text);
    const end = run == null ? GO_END.exec(text) : null;
    if (run != null) {
      goCurrent = run[2];
      if (run[1] === 'RUN' || !goDetails.has(goCurrent)) goDetails.set(goCurrent, []);
    } else if (end != null) {
      const details = goDetails.get(end[2]);
      goDetails.delete(end[2]);
      if (goCurrent === end[2]) goCurrent = null;
      if (end[1] === 'FAIL' && verdict(i)) {
        for (const j of details || []) mark(j, 'assert');
        for (let j = i + 1, n = 0; j < texts.length && n < DETAIL_MAX; j++) {
          if (skipped[j]) continue;
          if (!GO_DETAIL.test(texts[j]) || GO_MARK.test(texts[j])) break;
          mark(j, 'assert');
          n++;
        }
      }
    } else if (goCurrent !== null && GO_DETAIL.test(text)) {
      const details = goDetails.get(goCurrent);
      if (details.length < DETAIL_MAX) details.push(i);
    }
    if (ESLINT_ROW.test(text)) {
      if (fileLine !== -1 && verdict(i) && ESLINT_ERROR_ROW.test(text)) mark(fileLine, 'stack');
    } else if (text.trim() !== '') {
      fileLine = FILE_LINE.test(text) ? i : -1;
    }
    const failed = verdict(i) ? FAIL_FILE_LINE.exec(text) : null;
    if (failed != null) {
      const under = failed[1].length;
      for (let j = i + 1, n = 0; j < texts.length && n < FAIL_DETAIL_MAX; j++) {
        if (skipped[j]) continue;
        if (texts[j].trim() === '' || indentOf(texts[j]) <= under || verdict(j)) break;
        mark(j, 'assert');
        n++;
      }
    }
    if (verdict(i) && NODE_ASSERTION.test(text)) {
      for (let j = i + 1; j < texts.length && j <= i + ASSERT_FRAME_WITHIN; j++) {
        if (skipped[j] || !FRAME.test(texts[j])) continue;
        let k = j - 1;
        while (k > i && (skipped[k] || texts[k].trim() === '')) k--;
        if (k - i > BOUNDS.PER_LINES && texts[k].length <= NODE_COMPARISON_MAX && NODE_COMPARISON.test(texts[k]) && !FRAME.test(texts[k])) mark(k, 'assert');
        break;
      }
    }
    if (verdict(i) && RUSTC_ERROR.test(text)) {
      for (let j = i + 1, seen = 0; j < texts.length && seen < RUSTC_AT_WITHIN; j++) {
        if (skipped[j]) continue;
        seen++;
        if (RUSTC_AT.test(texts[j])) { mark(j, 'stack'); break; }
      }
    }
    if (verdict(i) && PANIC.test(text)) {
      for (let j = i + 1, n = 0; j < texts.length && n < DETAIL_MAX; j++) {
        if (skipped[j]) continue;
        if (PANIC_END.test(texts[j])) break;
        mark(j, 'assert');
        n++;
      }
    }
  }
}

// A parallel runner's tag before a line ("[a.test.js] ", "[0] ", docker
// compose's "web-1  | ", turbo's "pkg:test: "). It is read through only when
// what follows is a test runner's own mark, so "[ERROR] x" stays as it is.
// (never file.js:12:, whose second part is a number)
const RUN_TAG = /^(?:\[[^\]]{1,80}\]|[\w@.\/-]{1,60} +\||[\w@.\/-]{1,60}:(?!\d)[\w.-]{1,40}:) ?/;
// (in a value block, a bracket holding a list or a time is the line's text,
// and so is a bare [1])
const blockTag = (text) => {
  const m = RUN_TAG.exec(text);
  if (m == null || !m[0].startsWith('[')) return m;
  const inner = m[0].trim().slice(1, -1);
  return /[,:\s]/.test(inner) || (/^\d+$/.test(inner) && text.slice(m[0].length).trim() === '') ? null : m;
};
const tagOf = (text) => { const m = blockTag(text); return m == null ? '' : m[0].trim(); };
const bodyOf = (text) => { const m = blockTag(text); return m == null ? text : text.slice(m[0].length); };
const RUNNER_MARK = /^\s*(?:[✔✓✖●\ufe63]|not ok\b|ok\s|PASS\s|--- (?:PASS|SKIP|FAIL):|=== (?:RUN|PAUSE|CONT|NAME)\s|expect\(|(?:Expected|Received)(?: [\w ]+)?:)/;
// (a severity word is the line's own verdict, never a runner's name)
// (alone in the tag, not a part of a file's or a package's name)
const SEVERITY_TAG = /(?<![\w./@-])(?:ERROR|ERR|FATAL|FAIL|FAILED|FAILURE|CRITICAL|PANIC|WARN|WARNING)(?![\w./@-])/i;
function untagged(text) {
  const m = RUN_TAG.exec(text);
  if (m == null || SEVERITY_TAG.test(m[0])) return text;
  const body = text.slice(m[0].length);
  return RUNNER_MARK.test(body) ? body : text;
}

function classify(line) {
  if (EXIT.test(line)) return 'exit';
  const text = untagged(line);
  if (FRAME.test(text) || TAP_DIRECTIVE.test(text) || PASSED.test(text) || NOT_AN_ERROR.test(text)) return null;
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
  const scans = []; // each step's {texts, kinds, skipped}, for its value blocks
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
    for (let i = 1; i < texts.length; i++) {
      if (kinds[i] !== null && ENDS_OK.test(texts[i]) && UNITTEST_ID.test(texts[i - 1])) kinds[i] = null;
    }
    markDetails(texts, kinds, skipped);
    scans.push({texts, kinds, skipped});
    kinds.forEach((kind, index) => {
      if (kind !== null) found.push({s, index, text: texts[index], kind: kind === 'frame' ? 'stack' : kind, count: entries[index].count, failure: failure.get(index)});
    });
  });

  // The last exit line: an earlier one is a continue-on-error step's.
  const exitAt = found.findLast((l) => l.kind === 'exit');
  const lastError = found.findLast((l) => l.kind === 'error' || l.kind === 'assert');
  const fromApi = failedFromConclusions(steps, stepConclusions);
  const failing = fromApi !== null ? fromApi : exitAt ? exitAt.s : lastError ? lastError.s : null;

  // The failing step's own matches decide (the final pass on the packs, A4: an earlier
  // step's warnings never keep its tail out).
  let t = failing;
  if (t === null) {
    for (let s = steps.length - 1; s >= 0 && t === null; s--) if (/^Run /.test(steps[s].name)) t = s;
  }
  const own = t === null ? [] : found.filter((l) => l.s === t);
  if (t !== null && own.filter((l) => !NPM_LINE.test(l.text)).length < TAIL_BELOW) {
    const taken = new Set(own.map((l) => l.index));
    const entries = normalised[t];
    for (let index = Math.max(0, entries.length - TAIL_LINES); index < entries.length; index++) {
      if (!taken.has(index) && entries[index] != null && !INTERNAL_FRAME.test(entries[index].text)) found.push({s: t, index, text: entries[index].text, kind: 'tail', count: entries[index].count});
    }
  }

  const byLog = (a, b) => (a.s - b.s) || (a.index - b.index);
  const rankOf = (l) => (l.failure != null && l.kind !== 'stack' ? RANK.failure : RANK[l.kind]);
  const byKeep = (a, b) => ((b.s === failing) - (a.s === failing)) || (rankOf(a) - rankOf(b)) || byLog(a, b);
  const kept = [...found].sort(byKeep).slice(0, maxLines).sort(byLog);
  // (the failing step's failed assertions: their values, beside `lines`)
  const places = new Map(kept.map((l, place) => [l, place]).filter(([l]) => l.s === t).map(([l, place]) => [l.index, place]));
  const repeatsOf = (i) => (normalised[t][i] == null ? 1 : normalised[t][i].count);
  const details = t === null ? null : valueBlocks({...scans[t], placeOf: (i) => (places.has(i) ? places.get(i) : -1), isWhole: (i) => cutLine(cutJson(scans[t].texts[i])) === scans[t].texts[i], repeatsOf, tagOf, bodyOf, step: cutName(steps[t].name), cut: cutLine});
  return {
    failingStep: failing === null ? null : cutName(steps[failing].name),
    lines: kept.map((l) => ({step: cutName(steps[l.s].name), index: l.index, text: cutLine(cutJson(l.text)), kind: l.kind,
      ...(l.count > 1 ? {repeats: l.count} : {}), ...(l.failure != null ? {failure: l.failure} : {})})),
    truncated: found.length > maxLines,
    rules: RULES,
    ...(details == null ? {} : {details})
  };
}

module.exports = {extractErrors, RULES, LINE_MAX};
