#!/usr/bin/env node
/**
 * terminal-driver-mcp — PTY-backed terminal MCP server.
 *
 * Gives agents a real terminal: node-pty allocates PTYs so applications
 * behave interactively, @xterm/headless mirrors the screen in memory, and
 * tools expose snapshots, keystrokes, and synchronization primitives.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runTestFiles } from "./runner.js";
import { killAll } from "./session-manager.js";
import { log, registerTools } from "./tools.js";

// CLI mode: `terminal-driver-mcp run <test.json...>` replays test scripts and
// exits — no MCP server, no LLM. Everything below this block is server-only.
if (process.argv[2] === "run") {
  process.on("exit", () => killAll());
  const code = await runTestFiles(process.argv.slice(3), (line) => process.stdout.write(`${line}\n`));
  process.exit(code);
}

// stdout is reserved for MCP protocol traffic; redirect any stray
// console.log (ours or a dependency's) to stderr.
console.log = console.error;

const server = new McpServer({ name: "terminal-driver-mcp", version: "0.3.1" });
registerTools(server);

// Zombie prevention: no PTY child may outlive this server.
process.on("exit", () => killAll());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    killAll();
    process.exit(0);
  });
}
// The MCP client (e.g. Claude Code) closing stdin means we are orphaned.
process.stdin.on("close", () => {
  killAll();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
log("terminal-driver-mcp connected via stdio");
