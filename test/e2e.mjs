// End-to-end test: drives terminal-driver-mcp over stdio JSON-RPC and runs vim + resize scenarios.
import { spawn } from "node:child_process";
import { unlinkSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const TESTFILE = "/tmp/terminal-driver-mcp-e2e.txt";
if (existsSync(TESTFILE)) unlinkSync(TESTFILE);

const REC_DIR = join(dirname(fileURLToPath(import.meta.url)), ".recordings-test");
rmSync(REC_DIR, { recursive: true, force: true });
const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR },
});
child.stderr.on("data", () => {});

let nextId = 1;
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const notify = (method) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

async function call(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: protocol error ${JSON.stringify(res.error)}`);
  const text = res.result.content.map((c) => c.text).join("\n");
  return { isError: !!res.result.isError, text };
}

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(detail.split("\n").map((l) => "    " + l).join("\n"));
  }
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "e2e", version: "0" },
});
notify("notifications/initialized");

// --- vim scenario ---
let r = await call("session_create", { session_id: "v", command: `vim -u NONE ${TESTFILE}`, cols: 100, rows: 24 });
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
check("unknown session is a tool error", r.isError && r.text.includes('No session'), r.text);

// --- shell echo + resize scenario ---
r = await call("session_write", { session_id: "sh", input: "echo marker-$((21+21))", special_keys: ["enter"] });
check("shell echo", !r.isError, r.text);
r = await call("session_wait", { session_id: "sh", pattern: "marker-42", timeout_ms: 5000 });
check("wait for echo output", !r.isError, r.text);

r = await call("session_resize", { session_id: "sh", cols: 60, rows: 15 });
check("session_resize", !r.isError && r.text.includes("60x15"), r.text);

r = await call("session_list", {});
check("session_list shows both sessions", !r.isError && r.text.includes("v ") && r.text.includes("sh "), r.text);

// --- new: execute_command one-shot ---
r = await call("execute_command", { command: "echo one-$((40+2)); exit 0" });
check("execute_command success", !r.isError && r.text.includes("Exit code: 0") && r.text.includes("one-42"), r.text);

r = await call("execute_command", { command: "echo doomed; exit 3" });
check("execute_command nonzero exit code", !r.isError && r.text.includes("Exit code: 3") && r.text.includes("doomed"), r.text);

r = await call("execute_command", { command: "echo started; sleep 30", timeout_ms: 1000 });
check("execute_command timeout kills and returns partial output", r.isError && r.text.includes("started"), r.text);

r = await call("execute_command", { command: "pwd", cwd: "/tmp" });
check("execute_command cwd honored", !r.isError && /\/tmp/.test(r.text), r.text);

r = await call("execute_command", { command: "true", cwd: "/no/such/dir" });
check("bad cwd is a clear tool error", r.isError && r.text.includes("not an existing directory"), r.text);

// --- new: scrollback read ---
r = await call("execute_command", { command: "seq 1 200" });
check("execute_command captures scrolled-off output", !r.isError && r.text.includes("\n1\n") && r.text.includes("200"), r.text);

r = await call("session_create", { session_id: "scroll", command: "seq 1 100; sleep 60", cols: 80, rows: 20 });
await call("session_wait", { session_id: "scroll", pattern: "100", timeout_ms: 5000 });
r = await call("session_read", { session_id: "scroll" });
check("visible screen omits early output and hints at scrollback",
  !r.isError && !/^1$/m.test(r.text.split("]\n")[1] ?? "") && r.text.includes("scrolled off-screen"), r.text);
r = await call("session_read", { session_id: "scroll", scrollback_lines: 1000 });
check("scrollback_lines recovers early output", !r.isError && /^1$/m.test(r.text), r.text);
await call("session_kill", { session_id: "scroll" });

// --- new: stable_screen wait mode ---
r = await call("session_create", { session_id: "st", command: "echo settled; sleep 60" });
r = await call("session_wait_idle", { session_id: "st", mode: "stable_screen", idle_ms: 200, timeout_ms: 5000 });
check("stable_screen wait resolves on static screen", !r.isError && r.text.includes("unchanged"), r.text);
await call("session_kill", { session_id: "st" });

// --- new: asciicast recording ---
r = await call("session_create", { session_id: "rec", command: "echo recorded; sleep 60" });
const recPath = (r.text.match(/Recording: (.+\.cast)/) ?? [])[1];
check("session_create reports recording path", !!recPath, r.text);
await call("session_write", { session_id: "rec", input: "", special_keys: ["enter"] });
await call("session_kill", { session_id: "rec" });
if (recPath) {
  const cast = readFileSync(recPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("asciicast v2 header", cast[0].version === 2 && cast[0].width === 120, JSON.stringify(cast[0]));
  check("asciicast has output and input events",
    cast.some((e) => Array.isArray(e) && e[1] === "o" && e[2].includes("recorded")) &&
    cast.some((e) => Array.isArray(e) && e[1] === "i"),
    JSON.stringify(cast.slice(1, 5)));
} else {
  failures += 2;
}

// --- new: cursor + region + exact_col ---
r = await call("session_create", { session_id: "cur", command: "printf 'ABCDEF\\nGHIJKL\\n'; sleep 60", cols: 40, rows: 10 });
check("header includes cursor position", /cursor \d+:\d+/.test(r.text), r.text);
r = await call("session_region", { session_id: "cur", row: 0, col: 2, width: 3, height: 2 });
check("session_region extracts rectangle", !r.isError && r.text.includes("CDE") && r.text.includes("IJK"), r.text);
r = await call("session_assert", { session_id: "cur", expected_text: "GHI", exact_row: 1, exact_col: 0 });
check("assert exact_col pass", !r.isError, r.text);
r = await call("session_assert", { session_id: "cur", expected_text: "GHI", exact_row: 1, exact_col: 3 });
check("assert exact_col fail shows expected vs actual", r.isError && r.text.includes("Expected"), r.text);
await call("session_kill", { session_id: "cur" });

// --- new: run_test tool (inline) ---
const passingTest = {
  name: "vim regression",
  command: `vim -u NONE /tmp/terminal-driver-mcp-runner.txt`,
  cols: 90, rows: 20,
  steps: [
    { wait: "~", timeout_ms: 8000 },
    { write: "iruntest", keys: ["escape"] },
    { assert: "runtest", row: 0, col: 0 },
    { write: ":q!", keys: ["enter"] },
    { expect_exit: 0 },
  ],
};
r = await call("run_test", { test_json: JSON.stringify(passingTest) });
check("run_test inline passes all steps", !r.isError && r.text.startsWith("PASS") && r.text.includes("step 5"), r.text);

const failingTest = {
  name: "should fail",
  command: "echo hello; sleep 60",
  steps: [{ idle_ms: 100 }, { assert: "goodbye" }],
};
r = await call("run_test", { test_json: JSON.stringify(failingTest) });
check("run_test reports failing step with screen", r.isError && r.text.includes("✗ step 2") && r.text.includes("Final screen"), r.text);

r = await call("run_test", { test_json: JSON.stringify({ steps: [{ bogus: true }] }) });
check("run_test rejects invalid spec", r.isError && r.text.includes("invalid test spec"), r.text);

// --- kill + zombie check ---
const pidMatch = r.text.match(/sh\s+pid=(\d+)/);
const shPid = pidMatch ? Number(pidMatch[1]) : null;
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
try { process.kill(zPid, 0); } catch { alive = false; }
check("no zombie after server SIGTERM", !alive, `pid ${zPid} still alive`);

// --- new: CLI runner mode (separate process, CI shape) ---
const cliTestFile = join(REC_DIR, "cli-test.json");
writeFileSync(cliTestFile, JSON.stringify({
  name: "cli smoke",
  command: "echo cli-ok",
  steps: [{ wait: "cli-ok" }, { expect_exit: 0 }],
}));
try {
  const out = execFileSync("node", [SERVER, "run", cliTestFile], {
    encoding: "utf8",
    env: { ...process.env, TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR },
  });
  check("CLI run passes with exit 0", out.includes("PASS: cli smoke"), out);
} catch (err) {
  check("CLI run passes with exit 0", false, String(err.stdout || err));
}
writeFileSync(cliTestFile, JSON.stringify({
  name: "cli fail",
  command: "echo cli-ok",
  steps: [{ wait: "never-appears", timeout_ms: 500 }],
}));
try {
  execFileSync("node", [SERVER, "run", cliTestFile], {
    encoding: "utf8",
    env: { ...process.env, TERMINAL_DRIVER_MCP_RECORDING_DIR: REC_DIR },
  });
  check("CLI run fails with nonzero exit", false, "exited 0 unexpectedly");
} catch (err) {
  check("CLI run fails with nonzero exit", err.status === 1 && String(err.stdout).includes("FAIL"), String(err.stdout || err));
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
