// biome-ignore-all lint/suspicious/noControlCharactersInRegex: matching ESC (\x1b) in escape sequences is this file's whole purpose.
// Torture TUI: an adversarial terminal app for the gauntlet test.
//
// Runs INSIDE a session PTY and exercises the behaviors that break naive
// terminal automation: startup capability probes (apps hang if unanswered),
// escape sequences split across writes, wide characters, a continuously
// redrawing alternate-screen frame loop (catches stale-snapshot bugs), a key
// oracle that reports exact received bytes (catches encoding bugs, including
// DECCKM-dependent arrows), SIGWINCH reporting, and a slow-rendering dialog.
//
// Stages run in LOCKSTEP with the driver: each blocks on a proceed keypress
// before running, so its output is always observable and never scrolls away
// under a later stage. Raw mode disables output post-processing, so every
// line ends with \r\n.
const W = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.stdin.isTTY) {
  console.error("torture-tui must run on a TTY");
  process.exit(2);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("latin1");

let inBuf = "";
process.stdin.on("data", (d) => {
  inBuf += d;
});

// Wait until the input buffer matches, consuming through the end of the match.
async function readUntil(re, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const m = inBuf.match(re);
    if (m) {
      inBuf = inBuf.slice(m.index + m[0].length);
      return m;
    }
    if (Date.now() - start >= timeoutMs) return null;
    await sleep(10);
  }
}

// Read one keypress: first byte, then everything that arrives within 60ms
// (escape sequences span several bytes).
async function readKey(timeoutMs = 15000) {
  const start = Date.now();
  while (inBuf.length === 0) {
    if (Date.now() - start >= timeoutMs) return "";
    await sleep(10);
  }
  for (;;) {
    const seen = inBuf.length;
    await sleep(60);
    if (inBuf.length === seen) break;
  }
  const key = inBuf;
  inBuf = "";
  return key;
}

// Block until the driver sends a proceed key; discards it and any buffered
// input so the next stage starts from a clean slate.
async function proceed() {
  inBuf = "";
  await readKey();
  inBuf = "";
}

// Render bytes readably: ESC marked, other control bytes as {hex}.
const show = (s) =>
  [...s]
    .map((ch) => {
      if (ch === "\x1b") return "<ESC>";
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) return `{${code.toString(16).padStart(2, "0")}}`;
      return ch;
    })
    .join("");

// Abandoned by the driver? Don't linger as a zombie workload.
setTimeout(() => process.exit(3), 120_000).unref();

W("BOOT\r\n");

// --- Stage 1: capability probes (unanswered probes hang real apps) ---
await proceed();
const PROBES = [
  { name: "DA1", send: "\x1b[c", expect: /\x1b\[\?[\d;]*c/ },
  { name: "CPR", send: "\x1b[6n", expect: /\x1b\[\d+;\d+R/ },
  { name: "DECRQM-2026", send: "\x1b[?2026$p", expect: /\x1b\[\?2026;\d+\$y/ },
  { name: "KITTY-KBD", send: "\x1b[?u", expect: /\x1b\[\?\d+u/ },
  { name: "OSC11-BG", send: "\x1b]11;?\x07", expect: /\x1b\]11;[\s\S]*?(\x07|\x1b\\)/ },
];
for (const probe of PROBES) {
  inBuf = "";
  W(probe.send);
  const reply = await readUntil(probe.expect, 1000);
  W(`PROBE ${probe.name} ${reply ? "ok" : "none"}\r\n`);
}
W("PROBES-DONE\r\n");

// --- Stage 2: split escape sequences + wide characters ---
await proceed();
W("\x1b[2J\x1b[H");
const colored = "SPLIT:\x1b[31mRED-OK\x1b[0m";
for (const ch of colored) {
  W(ch);
  await sleep(3);
}
// A multi-byte UTF-8 char split across writes (é = 0xC3 0xA9).
process.stdout.write(Buffer.from([0xc3]));
await sleep(5);
process.stdout.write(Buffer.from([0xa9]));
W("!\r\n");
W("WIDE:你好end\r\n"); // CJK cells are width 2: "end" must land at column 9
W("EMOJI:hi\r\n");
W("SPLIT-DONE\r\n");

// --- Stage 3: output firehose ---
await proceed();
for (let i = 1; i <= 1500; i++) W(`FH-${i}\r\n`);
W("FIREHOSE-DONE\r\n");

// --- Stage 4: alternate-screen frame loop (a snapshot must show a LIVE frame) ---
await proceed();
W("PRIMARY-MARKER\r\n");
W("\x1b[?1049h\x1b[2J\x1b[H");
for (let frame = 1; frame <= 150; frame++) {
  W(`\x1b[H\x1b[2KFRAME ${frame}`);
  await sleep(40);
}
W("\x1b[?1049l");
W("ALT-DONE\r\n");

// --- Stage 5: key oracle (exact bytes received, DECCKM on and off) ---
// No proceed gate: the driver drives each key directly.
W("KEYS-1 press a key\r\n");
W(`KEY1:${show(await readKey())}\r\n`);

W("\x1b[?1h"); // enable application cursor keys: arrows must switch to SS3
W("KEYS-2 press a key\r\n");
W(`KEY2:${show(await readKey())}\r\n`);
W("\x1b[?1l");

W("KEYS-3 press a key\r\n");
W(`KEY3:${show(await readKey())}\r\n`);

W("KEYS-4 press a key\r\n");
W(`KEY4:${show(await readKey())}\r\n`);

W("KEYS-5 press a key\r\n");
W(`KEY5:${show(await readKey())}\r\n`);

// --- Stage 6: SIGWINCH reporting ---
W(`RESIZE-READY ${process.stdout.columns}x${process.stdout.rows}\r\n`);
await new Promise((resolve) => {
  process.on("SIGWINCH", () => {
    W(`RESIZED ${process.stdout.columns}x${process.stdout.rows}\r\n`);
    resolve();
  });
});

// --- Stage 7: slow-rendering dialog ---
await sleep(1500);
inBuf = "";
W("CONFIRM? [y/n] ");
const answer = await readKey();
W(`\r\nCONFIRMED:${show(answer)}\r\n`);

W("GAUNTLET-COMPLETE\r\n");
process.exit(0);
