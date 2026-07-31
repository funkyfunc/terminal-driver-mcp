#!/usr/bin/env node
/**
 * terminal-driver-mcp — PTY-backed terminal MCP server.
 *
 * Gives agents a real terminal: node-pty allocates PTYs so applications
 * behave interactively, @xterm/headless mirrors the screen in memory, and
 * tools expose snapshots, keystrokes, and synchronization primitives.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runTestFiles } from "./runner.js";
import { killAll } from "./session-manager.js";
import { recordingToSkeleton } from "./skeleton.js";
import { log, registerTools } from "./tools.js";

// CLI mode: `terminal-driver-mcp run <test.json...>` replays test scripts and
// exits — no MCP server, no LLM. Everything below this block is server-only.
if (process.argv[2] === "run") {
  process.on("exit", () => killAll());
  const code = await runTestFiles(process.argv.slice(3), (line) => process.stdout.write(`${line}\n`));
  process.exit(code);
}

// CLI mode: `terminal-driver-mcp skeleton <in.cast> [out.json]` converts a
// recording into a run_test JSON draft (stdout, or a file if given).
if (process.argv[2] === "skeleton") {
  const [inFile, outFile] = process.argv.slice(3);
  if (!inFile) {
    process.stderr.write("Usage: terminal-driver-mcp skeleton <recording.cast> [out.json]\n");
    process.exit(2);
  }
  const spec = await recordingToSkeleton(readFileSync(inFile, "utf8"));
  const json = `${JSON.stringify(spec, null, 2)}\n`;
  if (outFile) {
    writeFileSync(outFile, json);
    process.stderr.write(`Wrote ${spec.steps.length}-step skeleton to ${outFile}\n`);
  } else {
    process.stdout.write(json);
  }
  process.exit(0);
}

// stdout is reserved for MCP protocol traffic; redirect any stray
// console.log (ours or a dependency's) to stderr.
console.log = console.error;

const server = new McpServer({ name: "terminal-driver-mcp", version: "1.1.0" });
registerTools(server);

// A stray error in an async path (e.g. an odd escape sequence from a
// multiplexer) must not crash the whole server and take every live session
// with it. Log loudly — silent crashes are what made past restarts look
// "random" — and keep serving; a genuinely broken single operation still
// surfaces through its own tool result.
process.on("uncaughtException", (err) => log("UNCAUGHT EXCEPTION (server kept alive):", err));
process.on("unhandledRejection", (reason) => log("UNHANDLED REJECTION (server kept alive):", reason));

// Deliberate teardown: kill every PTY child (no zombies) and say what
// triggered it, so a shutdown is never a mystery.
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason}); killing active sessions`);
  killAll();
  process.exit(0);
}

process.on("exit", () => killAll()); // last-resort synchronous sweep
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => shutdown(signal));
}
// The MCP client (e.g. Claude Code) closing stdin means we are orphaned.
process.stdin.on("close", () => shutdown("stdin closed (client disconnected)"));

await server.connect(new StdioServerTransport());
log("terminal-driver-mcp connected via stdio");
