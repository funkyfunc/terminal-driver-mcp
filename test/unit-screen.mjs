// Regression test for the stale-screen bug: snapshots must flush the parser
// BEFORE computing the visible-row window. If the window is computed first,
// pending output that scrolls the buffer makes the snapshot describe the
// pre-scroll screen — an agent then waits forever for text that is already
// visible.
import xterm from "@xterm/headless";
import { assertScreen, fullTranscript, snapshotText } from "../dist/screen.js";

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
  const atCol4 = await assertScreen(session, "end", 0, 4);
  check("exact_col accounts for wide chars (end at col 4)", atCol4.ok, atCol4.message);
  const atCol2 = await assertScreen(session, "end", 0, 2);
  check("exact_col rejects wrong column for wide chars", !atCol2.ok, atCol2.message);
}

console.log(failures === 0 ? "\nUNIT TESTS PASSED" : `\n${failures} UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
