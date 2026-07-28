// The gauntlet: drives the torture TUI through the real MCP server and
// asserts the behaviors that break naive terminal automation. Stages run in
// lockstep — proceed() releases the app's next stage — so every marker is
// observable and nothing scrolls away before it is checked.
import { join } from "node:path";
import { makeChecker, startServer, TEST_DIR } from "./mcp-client.mjs";

const { check, summary } = makeChecker();
const { child, call } = await startServer({
  TERMINAL_DRIVER_MCP_RECORDING_DIR: join(TEST_DIR, ".recordings-test"),
});

const ID = "gauntlet";
const TORTURE = join(TEST_DIR, "torture-tui.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (pattern, timeout_ms = 10000) => call("session_wait", { session_id: ID, pattern, timeout_ms });
// Release the app's next stage (it blocks on a keypress between stages).
const proceed = () => call("session_write", { session_id: ID, special_keys: ["space"] });

let r = await call("session_create", {
  session_id: ID,
  command: `node ${TORTURE}`,
  cols: 90,
  rows: 26,
});
check("torture app starts", !r.isError, r.text);
r = await wait("BOOT", 8000);
check("torture app reaches lockstep boot", !r.isError, r.text);

// --- Stage 1: capability probes ---
await proceed();
r = await wait("PROBES-DONE");
check("probe stage completes (no hang)", !r.isError, r.text);
check("DA1 probe answered", r.text.includes("PROBE DA1 ok"), r.text);
check("CPR cursor-position probe answered", r.text.includes("PROBE CPR ok"), r.text);
for (const line of r.text.split("\n")) {
  if (line.startsWith("PROBE ")) console.log(`  info: ${line}`);
}

// --- Stage 2: split escape sequences + wide characters ---
await proceed();
r = await wait("SPLIT-DONE");
check("split-sequence stage completes", !r.isError, r.text);
check(
  "byte-split color sequence renders cleanly",
  r.text.includes("RED-OK") && !r.text.includes("[31m"),
  r.text,
);
check("byte-split UTF-8 char renders", r.text.includes("RED-OKé!"), r.text);
r = await call("session_assert", { session_id: ID, check: "at", text: "end", row: 1, col: 9 });
check("CJK wide chars occupy 2 columns each", !r.isError, r.text);
r = await call("session_assert", { session_id: ID, text: "EMOJI:hi" });
check("emoji line renders", !r.isError, r.text);

// --- Stage 3: firehose ---
await proceed();
r = await wait("FIREHOSE-DONE", 20000);
check("firehose completes", !r.isError, r.text);
check("firehose screen is current (shows final line)", r.text.includes("FH-1500"), r.text);

// --- Stage 4: alternate-screen frame loop (snapshots must be LIVE) ---
await proceed();
r = await wait("FRAME \\d+");
check("alt-screen frame loop starts", !r.isError, r.text);

const frameOf = (text) => {
  const m = text.match(/FRAME (\d+)/);
  return m ? Number(m[1]) : -1;
};
r = await call("session_read", { session_id: ID });
const frame1 = frameOf(r.text);
await sleep(400);
r = await call("session_read", { session_id: ID });
const frame2 = frameOf(r.text);
check(
  "snapshots of a redrawing screen are LIVE, not stale",
  frame1 > 0 && frame2 > frame1,
  `frame1=${frame1} frame2=${frame2}`,
);

r = await wait("ALT-DONE");
check("alt buffer exits", !r.isError, r.text);
check("primary screen restored after alt buffer", r.text.includes("PRIMARY-MARKER"), r.text);

// --- Stage 5: key oracle (exact bytes, DECCKM on and off) ---
async function pressAndReport(prompt, key, reportPattern) {
  const seen = await wait(prompt, 8000);
  if (seen.isError) return seen;
  await call("session_write", { session_id: ID, special_keys: [key] });
  return wait(reportPattern, 8000);
}

r = await pressAndReport("KEYS-1", "up", "KEY1:.+");
check("arrow up (DECCKM off) arrives as CSI <ESC>[A", !r.isError && r.text.includes("KEY1:<ESC>[A"), r.text);

r = await pressAndReport("KEYS-2", "up", "KEY2:.+");
check("arrow up (DECCKM on) switches to SS3 <ESC>OA", !r.isError && r.text.includes("KEY2:<ESC>OA"), r.text);

r = await pressAndReport("KEYS-3", "shift+escape", "KEY3:.+");
check("shift+escape arrives as CSI-u <ESC>[27;2u", !r.isError && r.text.includes("KEY3:<ESC>[27;2u"), r.text);

r = await pressAndReport("KEYS-4", "ctrl+r", "KEY4:.+");
check("ctrl+r arrives as 0x12", !r.isError && r.text.includes("KEY4:{12}"), r.text);

r = await pressAndReport("KEYS-5", "ctrl+]", "KEY5:.+");
check("ctrl+] arrives as legacy 0x1d (not CSI-u)", !r.isError && r.text.includes("KEY5:{1d}"), r.text);

// --- Stage 6: SIGWINCH ---
r = await wait("RESIZE-READY", 8000);
check("resize stage ready at 90x26", !r.isError && r.text.includes("RESIZE-READY 90x26"), r.text);
await call("session_resize", { session_id: ID, cols: 100, rows: 28 });
r = await wait("RESIZED", 8000);
check("app observes SIGWINCH with new size", !r.isError && r.text.includes("RESIZED 100x28"), r.text);

// --- Stage 7: slow dialog ---
r = await wait("CONFIRM\\?", 10000);
check("slow dialog eventually renders", !r.isError, r.text);
await call("session_write", { session_id: ID, input: "y" });
r = await wait("CONFIRMED:y", 8000);
check("dialog receives the answer", !r.isError, r.text);

// --- Completion ---
r = await wait("GAUNTLET-COMPLETE", 8000);
check("gauntlet completes", !r.isError, r.text);
await call("session_wait", { session_id: ID, until: "idle", idle_ms: 100, timeout_ms: 5000 });
r = await call("session_read", { session_id: ID });
check("torture app exited cleanly", !r.isError && r.text.includes("exited(0)"), r.text);
await call("session_kill", { session_id: ID });

child.kill();
process.exit(summary("GAUNTLET"));
