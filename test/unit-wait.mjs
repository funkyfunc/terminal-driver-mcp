// Frame-tear guard on pattern waits: a match that lands mid-repaint must not
// return the torn frame. waitForPattern settles (bounded quiet-wait) after the
// match and returns the repainted screen — and says so when the matched
// content turned out to be transient.
import xterm from "@xterm/headless";
import { waitForPattern } from "../dist/wait.js";

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
  return { term, lastDataAt: Date.now(), exited: false, exitCode: null };
}

const paint = (session, data) => {
  session.term.write(data);
  session.lastDataAt = Date.now();
};

// The pattern matches on a half-painted frame; the rest of the frame arrives
// moments later. The returned screen must include the late content.
{
  const session = makeSession();
  paint(session, "STATUS: MATCH-TOKEN");
  setTimeout(() => paint(session, " [chip: ok] rest-of-frame"), 30);
  const r = await waitForPattern(session, /MATCH-TOKEN/, 5000);
  check("wait succeeds on the early match", r.ok, r.message);
  check(
    "returned screen is the settled frame, not the torn one",
    r.screen.includes("rest-of-frame"),
    r.screen,
  );
}

// Transient content: the match is repainted away during the settle. The wait
// still succeeds, returns the settled screen, and flags the transience.
{
  const session = makeSession();
  paint(session, "TOAST-SAVED");
  setTimeout(() => paint(session, "\x1b[2J\x1b[HAFTER-TOAST"), 30);
  const r = await waitForPattern(session, /TOAST-SAVED/, 5000);
  check("transient match still succeeds", r.ok, r.message);
  check("transient match returns the settled screen", r.screen.includes("AFTER-TOAST"), r.screen);
  check("transience is called out", r.message.includes("transient"), r.message);
}

// Already-quiet screens add (almost) no latency: the settle is measured from
// the last output byte, which is long past.
{
  const session = makeSession();
  paint(session, "STABLE-MARKER");
  session.lastDataAt = Date.now() - 1000; // output has been quiet for a second
  const t0 = Date.now();
  const r = await waitForPattern(session, /STABLE-MARKER/, 5000);
  check(
    "stable screen returns without settle latency",
    r.ok && Date.now() - t0 < 100,
    `${Date.now() - t0}ms`,
  );
}

// Timeout near-miss: the closest screen line to the pattern's literal part is
// shown, catching wrong/overspecified regexes (e.g. truncated status lines).
{
  const session = makeSession();
  paint(session, "STATUS: rea"); // truncated — the pattern expects the full word
  const r = await waitForPattern(session, /STATUS: ready/, 300);
  check(
    "timeout shows the closest screen line",
    !r.ok && r.message.includes("looks close") && r.message.includes("STATUS: rea"),
    r.message,
  );
}
{
  const session = makeSession();
  paint(session, "MENU-TITLE-XYZ trailing");
  const r = await waitForPattern(session, /MENU-TITLE-XYZ$/, 300); // literal present, anchor wrong
  check(
    "timeout flags a line containing the literal when the regex around it fails",
    !r.ok && r.message.includes("looks close") && r.message.includes("MENU-TITLE-XYZ"),
    r.message,
  );
}
{
  const session = makeSession();
  paint(session, "nothing similar here");
  const r = await waitForPattern(session, /COMPLETELY-DIFFERENT/, 300);
  check("no closest-line hint when nothing is close", !r.ok && !r.message.includes("looks close"), r.message);
}

// A continuously-painting app cannot stall the wait past the settle cap.
{
  const session = makeSession();
  paint(session, "ANIMATED");
  const painter = setInterval(() => paint(session, "."), 20);
  const t0 = Date.now();
  const r = await waitForPattern(session, /ANIMATED/, 5000);
  clearInterval(painter);
  check("settle is capped under continuous output", r.ok && Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
}

console.log(failures === 0 ? "\nWAIT UNIT TESTS PASSED" : `\n${failures} WAIT UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
