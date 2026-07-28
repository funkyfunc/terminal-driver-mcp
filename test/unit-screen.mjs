// Regression test for the stale-screen bug: snapshots must flush the parser
// BEFORE computing the visible-row window. If the window is computed first,
// pending output that scrolls the buffer makes the snapshot describe the
// pre-scroll screen — an agent then waits forever for text that is already
// visible.
import xterm from "@xterm/headless";
import { assertScreen, fullTranscript, snapshotCells, snapshotText } from "../dist/screen.js";

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`    ${detail}`);
  }
}

function makeSession() {
  const term = new xterm.Terminal({ cols: 80, rows: 10, scrollback: 1000, allowProposedApi: true });
  return { term };
}

// Queue 200 scrolling lines WITHOUT awaiting the parse, then snapshot immediately.
{
  const session = makeSession();
  let data = "";
  for (let i = 1; i <= 200; i++) data += `line-${i}\r\n`;
  data += "FINAL-MARKER";
  session.term.write(data);

  const screen = await snapshotText(session);
  check("snapshotText reflects data queued before the call", screen.includes("FINAL-MARKER"), screen);
}

// Same for fullTranscript: must include both the first and the last line.
{
  const session = makeSession();
  let data = "";
  for (let i = 1; i <= 200; i++) data += `line-${i}\r\n`;
  data += "FINAL-MARKER";
  session.term.write(data);

  const transcript = await fullTranscript(session);
  check(
    "fullTranscript reflects data queued before the call",
    transcript.includes("line-1") && transcript.includes("FINAL-MARKER"),
    transcript.slice(-200),
  );
}

// exact_col must be terminal-column accurate: a CJK wide char occupies two
// columns, so text after it sits at a higher column than its string offset.
{
  const session = makeSession();
  session.term.write("你好end"); // 你,好 are width-2; "end" starts at column 4
  const atCol4 = await assertScreen(session, "end", { row: 0, col: 4 });
  check("exact_col accounts for wide chars (end at col 4)", atCol4.ok, atCol4.message);
  const atCol2 = await assertScreen(session, "end", { row: 0, col: 2 });
  check("exact_col rejects wrong column for wide chars", !atCol2.ok, atCol2.message);
}

// absent + count modifiers on assertScreen.
{
  const session = makeSession();
  session.term.write("foo bar foo\r\nbaz");
  check("absent passes for missing text", (await assertScreen(session, "qux", { absent: true })).ok);
  check("absent fails for present text", !(await assertScreen(session, "baz", { absent: true })).ok);
  check("count matches exact occurrences", (await assertScreen(session, "foo", { count: 2 })).ok);
  check("count fails on wrong number", !(await assertScreen(session, "foo", { count: 3 })).ok);
  check("count=0 is equivalent to absent", (await assertScreen(session, "nope", { count: 0 })).ok);
  check(
    "count rejects row/col/absent combos",
    !(await assertScreen(session, "foo", { count: 1, absent: true })).ok,
  );
}

// regex option: expected is a regex source instead of a literal substring.
{
  const session = makeSession();
  session.term.write("build finished in 4.2s\r\nwarnings: 3");
  check(
    "regex matches on screen",
    (await assertScreen(session, "finished in \\d+\\.\\ds", { regex: true })).ok,
  );
  check("regex scoped to a row", (await assertScreen(session, "warnings: \\d+", { regex: true, row: 1 })).ok);
  check("regex count", (await assertScreen(session, "\\d+", { regex: true, count: 3 })).ok);
  check("regex mismatch fails", !(await assertScreen(session, "^nope$", { regex: true })).ok);
  check("regex rejects col", !(await assertScreen(session, "x", { regex: true, row: 0, col: 0 })).ok);
  const bad = await assertScreen(session, "[", { regex: true });
  check("invalid regex reported clearly", !bad.ok && bad.message.includes("invalid regex"), bad.message);
}

// near-miss hints on presence failures: wrap, case, spacing.
{
  const session = makeSession();
  // 80-col terminal: a 90-char line wraps across two rows.
  session.term.write(`${"x".repeat(75)}WRAPPED-MARKER\r\nHello World\r\na   b`);
  const wrap = await assertScreen(session, "WRAPPED-MARKER");
  check("wrap-split text hinted", !wrap.ok && wrap.message.includes("line break"), wrap.message);
  const kase = await assertScreen(session, "hello world");
  check("case-only mismatch hinted", !kase.ok && kase.message.includes("capitalization"), kase.message);
  const space = await assertScreen(session, "a b");
  check("spacing mismatch hinted", !space.ok && space.message.includes("spacing"), space.message);
  const none = await assertScreen(session, "zebra");
  check("no hint when nothing is close", !none.ok && !none.message.includes("Hint:"), none.message);
}

// snapshotCells: styled runs coalesce, colors/attrs surface, trailing blanks trimmed.
{
  const session = makeSession();
  await new Promise((r) => session.term.write("\x1b[31mRED\x1b[0m\x1b[1mBOLD\x1b[0m plain", r));
  const snap = await snapshotCells(session);
  const runs = snap.lines[0].runs;
  check(
    "snapshotCells coalesces the red run",
    runs[0]?.text === "RED" && !!runs[0]?.fg,
    JSON.stringify(runs),
  );
  check(
    "snapshotCells captures bold",
    runs[1]?.text === "BOLD" && runs[1]?.bold === true,
    JSON.stringify(runs),
  );
  check(
    "snapshotCells right-trims unstyled trailing spaces",
    runs[runs.length - 1]?.text === " plain",
    JSON.stringify(runs),
  );
  check(
    "snapshotCells reports cursor",
    typeof snap.cursor.row === "number" && typeof snap.cursor.col === "number",
    JSON.stringify(snap.cursor),
  );
}

console.log(failures === 0 ? "\nUNIT TESTS PASSED" : `\n${failures} UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
