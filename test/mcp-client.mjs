// Shared test harness: spawns the built server over stdio, speaks JSON-RPC,
// and provides the PASS/FAIL check helper used by every suite.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(TEST_DIR, "..", "dist", "index.js");

export async function startServer(env = {}) {
  const child = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  child.stderr.on("data", () => {});

  let nextId = 1;
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let idx = buf.indexOf("\n"); idx >= 0; idx = buf.indexOf("\n")) {
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async function call(name, args) {
    const res = await rpc("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${name}: protocol error ${JSON.stringify(res.error)}`);
    const text = res.result.content.map((c) => c.text).join("\n");
    return { isError: !!res.result.isError, text };
  }

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return { child, rpc, call };
}

export function makeChecker() {
  let failures = 0;
  function check(label, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
    if (!cond) {
      failures++;
      if (detail) {
        console.log(
          detail
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n"),
        );
      }
    }
  }
  function summary(name) {
    console.log(failures === 0 ? `\n${name}: ALL PASSED` : `\n${name}: ${failures} FAILURES`);
    return failures === 0 ? 0 : 1;
  }
  return { check, summary };
}
