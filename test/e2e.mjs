// End-to-end test: drives terminal-driver-mcp over stdio JSON-RPC and runs vim + resize scenarios.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeChecker, SERVER, startServer, TEST_DIR } from "./mcp-client.mjs";

const TESTFILE = "/tmp/terminal-driver-mcp-e2e.txt";
if (existsSync(TESTFILE)) unlinkSync(TESTFILE);

const REC_DIR = join(TEST_DIR, ".recordings-test");
rmSync(REC_DIR, { recursive: true, force: true });

const { check, summary } = makeChecker();
const { child, call } = await startServer({ TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR });

// --- vim scenario ---
let r = await call("session_create", {
  session_id: "v",
  command: `vim -u NONE ${TESTFILE}`,
  cols: 100,
  rows: 24,
});
check("session_create vim", !r.isError, r.text);

r = await call("session_wait", { session_id: "v", pattern: "~", timeout_ms: 8000 });
check("session_wait for vim tildes", !r.isError, r.text);

r = await call("session_write", { session_id: "v", input: "ihello world", special_keys: ["escape"] });
check("session_write insert text", !r.isError, r.text);

r = await call("session_assert", { session_id: "v", expected_text: "hello world", exact_row: 0 });
check("session_assert row 0", !r.isError, r.text);

r = await call("session_assert", { session_id: "v", expected_text: "goodbye", exact_row: 0 });
check("session_assert negative case reports failure", r.isError, r.text);

r = await call("session_write", { session_id: "v", input: ":wq", special_keys: ["enter"] });
check("session_write :wq", !r.isError, r.text);

await call("session_wait_idle", { session_id: "v", idle_ms: 100, timeout_ms: 5000 });
await new Promise((s) => setTimeout(s, 500));
const saved = existsSync(TESTFILE) ? readFileSync(TESTFILE, "utf8").trim() : "<missing>";
check("vim saved file contents", saved === "hello world", `got: ${saved}`);

r = await call("session_read", { session_id: "v" });
check("session_read after exit still works", !r.isError && r.text.includes("exited"), r.text);

// --- unknown key / unknown session errors ---
r = await call("session_create", { session_id: "sh", cols: 80, rows: 20 });
check("session_create interactive shell", !r.isError, r.text);
r = await call("session_write", { session_id: "sh", input: "", special_keys: ["bogus_key"] });
check("unknown special key is a tool error", r.isError && r.text.includes("Unknown special key"), r.text);
r = await call("session_read", { session_id: "nope" });
check("unknown session is a tool error", r.isError && r.text.includes("No session"), r.text);

// --- shell echo + resize scenario ---
r = await call("session_write", {
  session_id: "sh",
  input: "echo marker-$((21+21))",
  special_keys: ["enter"],
});
check("shell echo", !r.isError, r.text);
r = await call("session_wait", { session_id: "sh", pattern: "marker-42", timeout_ms: 5000 });
check("wait for echo output", !r.isError, r.text);

r = await call("session_resize", { session_id: "sh", cols: 60, rows: 15 });
check("session_resize", !r.isError && r.text.includes("60x15"), r.text);

r = await call("session_list", {});
check(
  "session_list shows both sessions",
  !r.isError && r.text.includes("v ") && r.text.includes("sh "),
  r.text,
);

// --- new: execute_command one-shot ---
r = await call("execute_command", { command: "echo one-$((40+2)); exit 0" });
check(
  "execute_command success",
  !r.isError && r.text.includes("Exit code: 0") && r.text.includes("one-42"),
  r.text,
);

r = await call("execute_command", { command: "echo doomed; exit 3" });
check(
  "execute_command nonzero exit code",
  !r.isError && r.text.includes("Exit code: 3") && r.text.includes("doomed"),
  r.text,
);

r = await call("execute_command", { command: "echo started; sleep 30", timeout_ms: 1000 });
check(
  "execute_command timeout kills and returns partial output",
  r.isError && r.text.includes("started"),
  r.text,
);

r = await call("execute_command", { command: "pwd", cwd: "/tmp" });
check("execute_command cwd honored", !r.isError && /\/tmp/.test(r.text), r.text);

r = await call("execute_command", { command: "true", cwd: "/no/such/dir" });
check("bad cwd is a clear tool error", r.isError && r.text.includes("not an existing directory"), r.text);

// --- new: scrollback read ---
r = await call("execute_command", { command: "seq 1 200" });
check(
  "execute_command captures scrolled-off output",
  !r.isError && r.text.includes("\n1\n") && r.text.includes("200"),
  r.text,
);

r = await call("session_create", {
  session_id: "scroll",
  command: "seq 1 100; sleep 60",
  cols: 80,
  rows: 20,
});
await call("session_wait", { session_id: "scroll", pattern: "100", timeout_ms: 5000 });
r = await call("session_read", { session_id: "scroll" });
check(
  "visible screen omits early output and hints at scrollback",
  !r.isError && !/^1$/m.test(r.text.split("]\n")[1] ?? "") && r.text.includes("scrolled off-screen"),
  r.text,
);
r = await call("session_read", { session_id: "scroll", scrollback_lines: 1000 });
check("scrollback_lines recovers early output", !r.isError && /^1$/m.test(r.text), r.text);
await call("session_kill", { session_id: "scroll" });

// --- new: stable_screen wait mode ---
r = await call("session_create", { session_id: "st", command: "echo settled; sleep 60" });
r = await call("session_wait_idle", {
  session_id: "st",
  mode: "stable_screen",
  idle_ms: 200,
  timeout_ms: 5000,
});
check("stable_screen wait resolves on static screen", !r.isError && r.text.includes("unchanged"), r.text);
await call("session_kill", { session_id: "st" });

// --- terminal query responses (DSR cursor report) ---
// A raw-mode reader sends ESC[6n and prints whatever comes back; a real
// terminal (and now our emulator) answers with ESC[row;colR.
const dsrScript =
  'import sys,tty,os; tty.setraw(0); os.write(1,b"\\x1b[6n"); r=os.read(0,32); ' +
  'os.write(1,b"REPLY:"+r.replace(b"\\x1b",b"<ESC>")+b":END")';
r = await call("session_create", { session_id: "q", command: `python3 -c '${dsrScript}'` });
r = await call("session_wait", { session_id: "q", pattern: "REPLY:.*:END", timeout_ms: 5000 });
check("emulator answers DSR cursor query", !r.isError && /<ESC>\[\d+;\d+R/.test(r.text), r.text);
await call("session_kill", { session_id: "q" });

// --- key encoding round-trips through a raw-mode reader ---
// The helper hex-encodes the bytes it receives (control chars are invisible
// on screen otherwise); we assert exact wire encodings.
const rawEchoScript =
  'import tty,os; tty.setraw(0); os.write(1,b"RAWREADY"); d=os.read(0,32); ' +
  'os.write(1,b"GOT:"+d.hex().encode()+b":DONE")';
async function echoKey(label, write, expectHex) {
  await call("session_create", { session_id: "echo", command: `python3 -c '${rawEchoScript}'` });
  await call("session_wait", { session_id: "echo", pattern: "RAWREADY", timeout_ms: 5000 });
  await call("session_write", { session_id: "echo", ...write });
  const got = await call("session_wait", { session_id: "echo", pattern: "GOT:.*:DONE", timeout_ms: 5000 });
  check(label, !got.isError && got.text.includes(`GOT:${expectHex}:DONE`), got.text);
  await call("session_kill", { session_id: "echo" });
}

// shift+escape has no legacy encoding -> CSI-u (ESC[27;2u).
await echoKey("shift+escape sends CSI-u 27;2u", { special_keys: ["shift+escape"] }, "1b5b32373b3275");
// ctrl+] DOES have a legacy byte (0x1d) -> must use it, not CSI-u.
await echoKey("ctrl+] sends legacy 0x1d", { special_keys: ["ctrl+]"] }, "1d");
// raw_hex escape hatch: send ESC[A (arrow up) as raw bytes.
await echoKey("raw_hex sends arbitrary bytes", { raw_hex: "1b5b41" }, "1b5b41");

// --- literal-key foot-guns are rejected with a hint ---
r = await call("session_create", { session_id: "hint", command: "sleep 60" });
r = await call("session_write", { session_id: "hint", input: "hello{enter}" });
check(
  "literal {enter} in input is rejected with a hint",
  r.isError && r.text.includes('special_keys: ["enter"]'),
  r.text,
);
r = await call("session_write", { session_id: "hint", input: "hello\\r" });
check(
  "literal \\r in input is rejected with a hint",
  r.isError && r.text.includes('special_keys: ["enter"]'),
  r.text,
);
r = await call("session_write", { session_id: "hint", raw_hex: "zzzz" });
check("invalid raw_hex is a clear error", r.isError && r.text.includes("not valid hex"), r.text);
await call("session_kill", { session_id: "hint" });

// --- input/keys ordering: Enter must land after input is fully rendered ---
// The mock box commits typed chars asynchronously; a submit key sent too
// early would capture partial text. session_write holds keys until input settles.
r = await call("session_create", {
  session_id: "box",
  command: `node ${join(TEST_DIR, "slow-input-box.mjs")}`,
});
await call("session_wait", { session_id: "box", pattern: "BOX-READY", timeout_ms: 5000 });
const typed = "the quick brown fox jumps over the lazy dog";
r = await call("session_write", { session_id: "box", input: typed, special_keys: ["enter"] });
r = await call("session_wait", { session_id: "box", pattern: "SUBMIT:\\[", timeout_ms: 5000 });
check(
  "Enter submits the complete input (no mid-text race)",
  !r.isError && r.text.includes(`SUBMIT:[${typed}]`),
  r.text,
);
await call("session_kill", { session_id: "box" });

// --- wait_idle returns a CURRENT screen (stale-family regression) ---
// Emit a burst faster than idle_ms, then a final marker and go quiet:
// wait_idle must wait through the burst and return a screen showing the
// marker, proving idle resolution flushes the parser (not a stale window).
r = await call("session_create", {
  session_id: "idle",
  command: "for i in 1 2 3 4 5; do printf 'BURST%s ' $i; sleep 0.06; done; printf IDLE-MARKER; sleep 60",
});
r = await call("session_wait_idle", { session_id: "idle", idle_ms: 150, timeout_ms: 5000 });
check("wait_idle returns a flushed, current screen", !r.isError && r.text.includes("IDLE-MARKER"), r.text);
await call("session_kill", { session_id: "idle" });

// --- new: asciicast recording ---
r = await call("session_create", { session_id: "rec", command: "echo recorded; sleep 60" });
const recPath = (r.text.match(/Recording: (.+\.cast)/) ?? [])[1];
check("session_create reports recording path", !!recPath, r.text);
await call("session_write", { session_id: "rec", input: "", special_keys: ["enter"] });
await call("session_kill", { session_id: "rec" });
if (recPath) {
  const cast = readFileSync(recPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  check("asciicast v2 header", cast[0].version === 2 && cast[0].width === 120, JSON.stringify(cast[0]));
  check(
    "asciicast has output and input events",
    cast.some((e) => Array.isArray(e) && e[1] === "o" && e[2].includes("recorded")) &&
      cast.some((e) => Array.isArray(e) && e[1] === "i"),
    JSON.stringify(cast.slice(1, 5)),
  );
} else {
  check("asciicast v2 header", false, "no recording path to inspect");
  check("asciicast has output and input events", false, "no recording path to inspect");
}

// --- new: cursor + region + exact_col ---
r = await call("session_create", {
  session_id: "cur",
  command: "printf 'ABCDEF\\nGHIJKL\\n'; sleep 60",
  cols: 40,
  rows: 10,
});
check("header includes cursor position", /cursor \d+:\d+/.test(r.text), r.text);
r = await call("session_region", { session_id: "cur", row: 0, col: 2, width: 3, height: 2 });
check(
  "session_region extracts rectangle",
  !r.isError && r.text.includes("CDE") && r.text.includes("IJK"),
  r.text,
);
r = await call("session_assert", { session_id: "cur", expected_text: "GHI", exact_row: 1, exact_col: 0 });
check("assert exact_col pass", !r.isError, r.text);
r = await call("session_assert", { session_id: "cur", expected_text: "GHI", exact_row: 1, exact_col: 3 });
check("assert exact_col fail shows expected vs actual", r.isError && r.text.includes("Expected"), r.text);
await call("session_kill", { session_id: "cur" });

// --- new: run_test tool (inline) ---
const passingTest = {
  name: "vim regression",
  command: `vim -u NONE /tmp/terminal-driver-mcp-runner.txt`,
  cols: 90,
  rows: 20,
  steps: [
    { wait: "~", timeout_ms: 8000 },
    { write: "iruntest", keys: ["escape"] },
    { assert: "runtest", row: 0, col: 0 },
    { write: ":q!", keys: ["enter"] },
    { expect_exit: 0 },
  ],
};
r = await call("run_test", { test_json: JSON.stringify(passingTest) });
check(
  "run_test inline passes all steps",
  !r.isError && r.text.startsWith("PASS") && r.text.includes("step 5"),
  r.text,
);

const failingTest = {
  name: "should fail",
  command: "echo hello; sleep 60",
  steps: [{ idle_ms: 100 }, { assert: "goodbye" }],
};
r = await call("run_test", { test_json: JSON.stringify(failingTest) });
check(
  "run_test reports failing step with screen",
  r.isError && r.text.includes("✗ step 2") && r.text.includes("Final screen"),
  r.text,
);

r = await call("run_test", { test_json: JSON.stringify({ steps: [{ bogus: true }] }) });
check("run_test rejects invalid spec", r.isError && r.text.includes("invalid test spec"), r.text);

// --- kill + zombie check ---
r = await call("session_kill", { session_id: "sh" });
check("session_kill", !r.isError, r.text);
r = await call("session_kill", { session_id: "v" });
check("session_kill exited session", !r.isError, r.text);

// Server-level zombie prevention: create a session, SIGTERM the server, verify pid gone.
r = await call("session_create", { session_id: "z", command: "sleep 300" });
const zPid = Number(r.text.match(/pid (\d+)/)[1]);
child.kill("SIGTERM");
await new Promise((s) => setTimeout(s, 700));
let alive = true;
try {
  process.kill(zPid, 0);
} catch {
  alive = false;
}
check("no zombie after server SIGTERM", !alive, `pid ${zPid} still alive`);

// --- new: CLI runner mode (separate process, CI shape) ---
const cliTestFile = join(REC_DIR, "cli-test.json");
writeFileSync(
  cliTestFile,
  JSON.stringify({
    name: "cli smoke",
    command: "echo cli-ok",
    steps: [{ wait: "cli-ok" }, { expect_exit: 0 }],
  }),
);
try {
  const out = execFileSync("node", [SERVER, "run", cliTestFile], {
    encoding: "utf8",
    env: { ...process.env, TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR },
  });
  check("CLI run passes with exit 0", out.includes("PASS: cli smoke"), out);
} catch (err) {
  check("CLI run passes with exit 0", false, String(err.stdout || err));
}
writeFileSync(
  cliTestFile,
  JSON.stringify({
    name: "cli fail",
    command: "echo cli-ok",
    steps: [{ wait: "never-appears", timeout_ms: 500 }],
  }),
);
try {
  execFileSync("node", [SERVER, "run", cliTestFile], {
    encoding: "utf8",
    env: { ...process.env, TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR },
  });
  check("CLI run fails with nonzero exit", false, "exited 0 unexpectedly");
} catch (err) {
  check(
    "CLI run fails with nonzero exit",
    err.status === 1 && String(err.stdout).includes("FAIL"),
    String(err.stdout || err),
  );
}

process.exit(summary("E2E"));
