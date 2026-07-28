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
const { child, call, rpc } = await startServer({ TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR });

// --- tool annotations surface via tools/list ---
{
  const list = await rpc("tools/list", {});
  const byName = Object.fromEntries((list.result?.tools ?? []).map((t) => [t.name, t]));
  check(
    "session_read is annotated read-only",
    byName.session_read?.annotations?.readOnlyHint === true,
    JSON.stringify(byName.session_read?.annotations),
  );
  check(
    "session_kill is annotated destructive",
    byName.session_kill?.annotations?.destructiveHint === true,
    JSON.stringify(byName.session_kill?.annotations),
  );
  check(
    "session_write is not read-only",
    byName.session_write?.annotations?.readOnlyHint === false,
    JSON.stringify(byName.session_write?.annotations),
  );
}

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

// absent: assert text is NOT on screen
r = await call("session_assert", { session_id: "v", expected_text: "goodbye", absent: true });
check("session_assert absent passes when text is gone", !r.isError && r.text.includes("is absent"), r.text);
r = await call("session_assert", { session_id: "v", expected_text: "hello world", absent: true });
check(
  "session_assert absent fails when text is present",
  r.isError && r.text.includes("should be absent"),
  r.text,
);

// count: exact occurrence assertion
r = await call("session_assert", { session_id: "v", expected_text: "hello world", count: 1 });
check(
  "session_assert count matches exact occurrences",
  !r.isError && r.text.includes("appears 1 time"),
  r.text,
);
r = await call("session_assert", { session_id: "v", expected_text: "hello world", count: 2 });
check("session_assert count fails on wrong count", r.isError && r.text.includes("found 1"), r.text);
r = await call("session_assert", { session_id: "v", expected_text: "hello world", count: 1, exact_row: 0 });
check(
  "session_assert count rejects row/col combo",
  r.isError && r.text.includes("cannot be combined"),
  r.text,
);

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

// --- wait absent: block until a pattern disappears ---
r = await call("session_create", {
  session_id: "gone",
  // Print SPIN, then after a beat clear the screen and print DONE.
  command: "printf 'SPIN\\n'; sleep 0.4; printf '\\033[2J\\033[H'; printf 'DONE\\n'; sleep 60",
  cols: 40,
  rows: 6,
});
r = await call("session_wait", { session_id: "gone", pattern: "SPIN", timeout_ms: 5000 });
check("wait sees the pattern first", !r.isError, r.text);
r = await call("session_wait", { session_id: "gone", pattern: "SPIN", absent: true, timeout_ms: 5000 });
check(
  "wait absent resolves once the pattern clears",
  !r.isError && r.text.includes("no longer present"),
  r.text,
);
await call("session_kill", { session_id: "gone" });

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

// --- write-then-expect (atomic write + wait) ---
r = await call("session_create", { session_id: "we", command: "sh -i" });
r = await call("session_write", {
  session_id: "we",
  input: "echo READY-$((6*7))",
  special_keys: ["enter"],
  expect: "READY-42",
  expect_timeout_ms: 5000,
});
check("write-then-expect returns on match in one call", !r.isError && r.text.includes("READY-42"), r.text);
r = await call("session_write", {
  session_id: "we",
  input: "true",
  special_keys: ["enter"],
  expect: "NEVER",
  expect_timeout_ms: 800,
});
check("write-then-expect times out with final screen", r.isError && r.text.includes("Timed out"), r.text);
await call("session_kill", { session_id: "we" });

// --- session_info reports what the app enabled ---
// A python app that turns on mouse tracking, bracketed paste, and alt screen.
const modesScript =
  'import sys,time; sys.stdout.write("\\x1b[?1049h\\x1b[?2004h\\x1b[?1000h\\x1b[?1006h"); sys.stdout.flush(); time.sleep(30)';
r = await call("session_create", { session_id: "info", command: `python3 -c '${modesScript}'` });
await call("session_wait_idle", { session_id: "info", idle_ms: 150, timeout_ms: 3000 });
r = await call("session_info", { session_id: "info" });
const info = r.isError ? {} : JSON.parse(r.text);
check("session_info reports alt screen", info.altScreen === true, r.text);
check("session_info reports bracketed paste", info.modes?.bracketedPaste === true, r.text);
check("session_info reports mouse tracking enabled", info.modes?.mouseTracking !== "none", r.text);

// --- mouse click round-trips as SGR when the app is listening ---
// The same session has mouse tracking on; make it echo received bytes.
r = await call("session_click", { session_id: "info", row: 4, col: 9, button: "left" });
check("session_click succeeds when mouse tracking is on", !r.isError, r.text);
await call("session_kill", { session_id: "info" });

// mouse guard: an app with no mouse tracking is rejected helpfully.
r = await call("session_create", { session_id: "nomouse", command: "sleep 30" });
r = await call("session_click", { session_id: "nomouse", row: 0, col: 0 });
check(
  "session_click errors when app has no mouse tracking",
  r.isError && r.text.includes("mouse tracking"),
  r.text,
);
await call("session_kill", { session_id: "nomouse" });

// mouse SGR bytes reach a raw reader that enabled SGR mouse mode.
const mouseEchoScript =
  'import tty,os,sys; sys.stdout.write("\\x1b[?1000h\\x1b[?1006h"); sys.stdout.flush(); tty.setraw(0); ' +
  'os.write(1,b"MOUSEREADY"); d=os.read(0,32); os.write(1,b"GOT:"+d.hex().encode()+b":DONE")';
r = await call("session_create", { session_id: "mouse", command: `python3 -c '${mouseEchoScript}'` });
await call("session_wait", { session_id: "mouse", pattern: "MOUSEREADY", timeout_ms: 5000 });
await call("session_click", { session_id: "mouse", row: 2, col: 5, button: "left" });
r = await call("session_wait", { session_id: "mouse", pattern: "GOT:.*:DONE", timeout_ms: 5000 });
// SGR press at (row2,col5) = ESC[<0;6;3M = hex 1b5b3c303b363b334d
check("mouse click sends SGR press sequence", !r.isError && r.text.includes("1b5b3c303b363b334d"), r.text);
await call("session_kill", { session_id: "mouse" });

// --- record -> skeleton -> replay round-trip (feature #5) ---
// Drive a `cat` session (deterministic echo), convert its recording into a
// run_test skeleton, and replay it — the full "drive once, get a test" loop.
r = await call("session_create", { session_id: "rt", command: "cat" });
const rtRecording = (r.text.match(/Recording: (.+\.cast)/) ?? [])[1];
check("round-trip: recording path reported", !!rtRecording, r.text);
await call("session_write", { session_id: "rt", input: "ROUNDTRIP-MARKER", special_keys: ["enter"] });
await call("session_wait", { session_id: "rt", pattern: "ROUNDTRIP-MARKER", timeout_ms: 5000 });
await call("session_kill", { session_id: "rt" });

r = await call("recording_to_test", { file: rtRecording });
check("round-trip: conversion returns JSON", !r.isError, r.text);
let skeleton = null;
try {
  skeleton = JSON.parse(r.text);
} catch {
  /* leave null */
}
check("round-trip: skeleton is valid JSON with steps", !!skeleton?.steps?.length, r.text);
check(
  "round-trip: skeleton captured the typed marker",
  skeleton?.steps?.some((s) => s.write?.includes("ROUNDTRIP-MARKER")),
  r.text,
);
r = await call("run_test", { test_json: JSON.stringify(skeleton) });
check("round-trip: generated skeleton replays GREEN", !r.isError && r.text.startsWith("PASS"), r.text);

// --- wait_idle returns a CURRENT, flushed screen ---
// A marker is printed and the session goes quiet. wait_idle must return a
// screen showing it. This is deterministic: no dependence on output timing
// (which flakes under CI load). The flush-before-read invariant that wait_idle
// relies on is pinned separately and deterministically in unit-screen.mjs.
r = await call("session_create", { session_id: "idle", command: "echo LINE-A; echo IDLE-MARKER; sleep 60" });
r = await call("session_wait_idle", { session_id: "idle", idle_ms: 100, timeout_ms: 5000 });
check("wait_idle returns a flushed, current screen", !r.isError && r.text.includes("IDLE-MARKER"), r.text);
await call("session_kill", { session_id: "idle" });

// --- shell_integration warns up front when it can't take effect ---
r = await call("session_create", { session_id: "siwarn", command: "cat", shell_integration: true });
check(
  "shell_integration with a command warns at creation",
  !r.isError && r.text.includes("WARNING") && r.text.includes("interactive shell"),
  r.text,
);
await call("session_kill", { session_id: "siwarn" });

// --- structured cell snapshot (colors/styles/cursor + OSC 8) ---
r = await call("session_create", {
  session_id: "cells",
  command: String.raw`printf '\033[31mRED\033[0m\033[1mBOLD\033[0m\n'; printf '\033]8;;https://example.com\033\\LINK\033]8;;\033\\\n'; sleep 60`,
  cols: 80,
  rows: 8,
});
await call("session_wait", { session_id: "cells", pattern: "LINK", timeout_ms: 5000 });
r = await call("session_read", { session_id: "cells", format: "json" });
let snap = null;
try {
  snap = JSON.parse(r.text);
} catch {
  /* leave null */
}
check("session_read json parses", !!snap?.lines, r.text);
check(
  "json snapshot carries a colored run",
  snap?.lines?.[0]?.runs?.some((run) => run.text === "RED" && run.fg),
  r.text,
);
check(
  "json snapshot carries a bold run",
  snap?.lines?.[0]?.runs?.some((run) => run.bold === true),
  r.text,
);
check(
  "json snapshot extracts OSC 8 link",
  snap?.links?.some((l) => l.url === "https://example.com"),
  r.text,
);

// --- session_screenshot returns a PNG image content block ---
const res = await rpc("tools/call", { name: "session_screenshot", arguments: { session_id: "cells" } });
const img = res.result?.content?.find((c) => c.type === "image");
check(
  "session_screenshot returns an image block",
  !!img && img.mimeType === "image/png",
  JSON.stringify(res.result?.content?.map((c) => c.type)),
);
const pngOk = img && Buffer.from(img.data, "base64").subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
check(
  "screenshot image is a valid PNG",
  !!pngOk,
  img ? `${Buffer.from(img.data, "base64").length} bytes` : "no image",
);
await call("session_kill", { session_id: "cells" });

// --- OSC 133 shell integration (semantic command boundaries) ---
// Dedicated server with a shell that supports the hooks: zsh everywhere it
// exists (verified), else bash (Linux CI has bash >= 4.4 with PS0).
{
  const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
  const si = await startServer({ SHELL: shell, TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR });
  const created = await si.call("session_create", { session_id: "si", shell_integration: true });
  check(
    "shell integration reported active",
    !created.isError && created.text.includes("OSC 133"),
    created.text,
  );

  await si.call("session_write", { session_id: "si", input: "echo si-marker-42", special_keys: ["enter"] });
  let cr = await si.call("session_wait_command", { session_id: "si", timeout_ms: 8000 });
  let cmd = null;
  try {
    cmd = JSON.parse(cr.text);
  } catch {
    /* leave null */
  }
  check(
    `shell integration (${shell}): captures output + exit 0`,
    !cr.isError && cmd?.output?.includes("si-marker-42") && cmd?.exit_code === 0,
    cr.text,
  );

  await si.call("session_write", { session_id: "si", input: "false", special_keys: ["enter"] });
  cr = await si.call("session_wait_command", { session_id: "si", timeout_ms: 8000 });
  try {
    cmd = JSON.parse(cr.text);
  } catch {
    /* leave null */
  }
  check(`shell integration (${shell}): captures nonzero exit`, !cr.isError && cmd?.exit_code === 1, cr.text);

  await si.call("session_kill", { session_id: "si" });
  si.child.kill();
}

// --- resilience: many concurrent heavy sessions don't take the server down ---
// Mimics a multiplexer-style load (several sessions streaming at once). All
// must stay alive and the server must keep responding.
for (let i = 0; i < 4; i++) {
  await call("session_create", { session_id: `load${i}`, command: "yes ABCDEFGH | head -50000; sleep 60" });
}
for (let i = 0; i < 4; i++)
  await call("session_wait_idle", { session_id: `load${i}`, idle_ms: 120, timeout_ms: 8000 });
r = await call("session_list", {});
const allAlive = [0, 1, 2, 3].every((i) => new RegExp(`load${i}\\s+pid=\\d+.*running`).test(r.text));
check("server survives concurrent heavy sessions", !r.isError && allAlive, r.text);
// And it still answers a fresh request afterwards.
r = await call("execute_command", { command: "echo STILL-RESPONSIVE" });
check("server still responsive after load", !r.isError && r.text.includes("STILL-RESPONSIVE"), r.text);
for (let i = 0; i < 4; i++) await call("session_kill", { session_id: `load${i}` });

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

// --- golden snapshots via the CLI: --update creates, plain run compares ---
const goldenFile = join(REC_DIR, "golden-test.json");
writeFileSync(
  goldenFile,
  JSON.stringify({
    name: "golden cli",
    command: "printf 'GOLDEN-LINE\\n'; sleep 60",
    cols: 40,
    rows: 6,
    steps: [{ wait: "GOLDEN-LINE" }, { match_screen: "main" }],
  }),
);
try {
  // First run without --update must fail (no golden yet).
  execFileSync("node", [SERVER, "run", goldenFile], { encoding: "utf8" });
  check("golden: missing snapshot fails before --update", false, "expected nonzero exit");
} catch (err) {
  check(
    "golden: missing snapshot fails before --update",
    err.status === 1 && /Run with --update/.test(String(err.stdout)),
    String(err.stdout || err),
  );
}
try {
  const created = execFileSync("node", [SERVER, "run", "--update", goldenFile], { encoding: "utf8" });
  check("golden: --update creates and passes", created.includes("PASS: golden cli"), created);
  const compared = execFileSync("node", [SERVER, "run", goldenFile], { encoding: "utf8" });
  check("golden: subsequent run matches", compared.includes("PASS: golden cli"), compared);
} catch (err) {
  check("golden: --update + compare round-trip", false, String(err.stdout || err));
}

// --- HTML trace viewer via the CLI ---
try {
  execFileSync("node", [SERVER, "run", "--trace", goldenFile], { encoding: "utf8" });
  const tracePath = goldenFile.replace(/\.json$/i, ".trace.html");
  const html = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
  check(
    "trace: --trace writes a self-contained HTML trace",
    html.startsWith("<!doctype html>") &&
      html.includes("GOLDEN-LINE") &&
      !/(src|href)=["']https?:/.test(html),
    `len=${html.length}`,
  );
} catch (err) {
  check("trace: --trace writes a self-contained HTML trace", false, String(err.stdout || err));
}

// --- soft assertions + grouping: a soft failure records but keeps running ---
const softFile = join(REC_DIR, "soft-test.json");
writeFileSync(
  softFile,
  JSON.stringify({
    name: "soft cli",
    command: "printf 'AAA\\nBBB\\n'; sleep 60",
    cols: 40,
    rows: 6,
    steps: [
      { wait: "AAA", group: "arrange" },
      { assert: "ZZZ-missing", soft: true, group: "assert" },
      { assert: "BBB", group: "assert" },
      { assert: "ZZZ-missing", absent: true, group: "assert" },
      { assert: "AAA", count: 1, group: "assert" },
    ],
  }),
);
try {
  execFileSync("node", [SERVER, "run", softFile], { encoding: "utf8" });
  check("soft: run with a soft failure exits nonzero", false, "expected nonzero exit");
} catch (err) {
  const out = String(err.stdout || "");
  check(
    "soft: fails overall but runs every step (soft failure does not stop)",
    err.status === 1 &&
      out.includes("FAIL: soft cli") &&
      /\(soft\)/.test(out) && // the soft assertion is marked
      /step 3:.*BBB/.test(out) && // the step *after* the soft failure still ran
      /step 4:.*assert not "ZZZ-missing"/.test(out) && // absent step rendered + ran
      /step 5:.*assert "AAA" ×1/.test(out) && // count step rendered + ran
      out.includes("▸ assert"), // group header rendered
    out,
  );
}

// --- retries / flake quarantine: fail once, pass on retry → reported flaky ---
// Deterministic flakiness: a marker file that only exists on the 2nd attempt.
const flakeMarker = join(REC_DIR, "flake-marker");
if (existsSync(flakeMarker)) unlinkSync(flakeMarker);
const flakeFile = join(REC_DIR, "flake-test.json");
writeFileSync(
  flakeFile,
  JSON.stringify({
    name: "flaky cli",
    command: `if [ -f '${flakeMarker}' ]; then echo READY; else : > '${flakeMarker}'; echo NOTYET; fi; sleep 60`,
    cols: 40,
    rows: 6,
    steps: [{ wait: "READY", timeout_ms: 1500 }],
  }),
);
try {
  const out = execFileSync("node", [SERVER, "run", "--retries", "1", flakeFile], {
    encoding: "utf8",
    env: { ...process.env, TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR },
  });
  check(
    "retries: a test that passes on retry is flaky, not failed (exit 0)",
    out.includes("PASS: flaky cli") && out.includes("FLAKY") && out.includes("(1 flaky)"),
    out,
  );
} catch (err) {
  check(
    "retries: a test that passes on retry is flaky, not failed (exit 0)",
    false,
    String(err.stdout || err),
  );
}
// A test that never passes still fails after exhausting the retry budget.
writeFileSync(
  flakeFile,
  JSON.stringify({
    name: "always fails",
    command: "echo hello; sleep 60",
    steps: [{ wait: "never-there", timeout_ms: 400 }],
  }),
);
try {
  execFileSync("node", [SERVER, "run", "--retries", "2", flakeFile], {
    encoding: "utf8",
    env: { ...process.env, TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR },
  });
  check("retries: exhausting retries still fails (exit 1)", false, "expected nonzero exit");
} catch (err) {
  const out = String(err.stdout || "");
  check(
    "retries: exhausting retries still fails (exit 1)",
    err.status === 1 && /retry 2\/2/.test(out) && out.includes("FAIL: always fails"),
    out,
  );
}

process.exit(summary("E2E"));
