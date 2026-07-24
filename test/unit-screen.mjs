// Regression test for the stale-screen bug: snapshots must flush the parser
// BEFORE computing the visible-row window. If the window is computed first,
// pending output that scrolls the buffer makes the snapshot describe the
// pre-scroll screen — an agent then waits forever for text that is already
// visible.
import xterm from "@xterm/headless";
import { fullTranscript, snapshotText } from "../dist/screen.js";

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

console.log(failures === 0 ? "\nUNIT TESTS PASSED" : `\n${failures} UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
