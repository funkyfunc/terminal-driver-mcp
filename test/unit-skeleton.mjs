// Unit tests for input decoding (inverse of encodeKey) and recording->skeleton.
import { decodeInput } from "../dist/keys.js";
import { parseCast, recordingToSkeleton } from "../dist/skeleton.js";

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`    ${detail}`);
  }
}
const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

// --- decodeInput: inverse of the key encoding ---
eq("text + escape", decodeInput("ihello\x1b"), [{ text: "ihello" }, { key: "escape" }]);
eq("SS3 arrow up", decodeInput("\x1bOA"), [{ key: "up" }]);
eq("CSI arrow up", decodeInput("\x1b[A"), [{ key: "up" }]);
eq("legacy ctrl+]", decodeInput("\x1d"), [{ key: "ctrl+]" }]);
eq("ctrl+r", decodeInput("\x12"), [{ key: "ctrl+r" }]);
eq("enter", decodeInput("\r"), [{ key: "enter" }]);
eq("CSI-u shift+escape", decodeInput("\x1b[27;2u"), [{ key: "shift+escape" }]);
eq("function key f5", decodeInput("\x1b[15~"), [{ key: "f5" }]);
eq("text then enter", decodeInput("ls\r"), [{ text: "ls" }, { key: "enter" }]);
// Unrecognized escape (SGR mouse press) -> raw_hex, byte-faithful.
eq("SGR mouse -> rawHex", decodeInput("\x1b[<0;6;3M"), [{ rawHex: "1b5b3c303b363b334d" }]);

// --- parseCast + recordingToSkeleton ---
const cast = [
  JSON.stringify({ version: 2, width: 80, height: 24, title: "vim -u NONE /tmp/x" }),
  JSON.stringify([0.1, "o", "\x1b[2J\x1b[H~\r\n"]),
  JSON.stringify([0.2, "i", "ihello world"]),
  JSON.stringify([0.3, "i", "\x1b"]),
  JSON.stringify([1.5, "i", ":wq\r"]), // 1.2s gap -> settle inserted before this
  JSON.stringify([1.6, "o", "hello world\r\n"]),
].join("\n");

const parsed = parseCast(cast);
check(
  "parseCast reads header",
  parsed.header.width === 80 && parsed.header.title.includes("vim"),
  JSON.stringify(parsed.header),
);
check("parseCast reads events", parsed.events.length === 5, `${parsed.events.length} events`);

const spec = await recordingToSkeleton(cast);
check("skeleton command from title", spec.command === "vim -u NONE /tmp/x", spec.command);
check("skeleton dims from header", spec.cols === 80 && spec.rows === 24, `${spec.cols}x${spec.rows}`);

const kinds = spec.steps.map((s) => Object.keys(s).sort().join("+"));
// Emitted JSON is clean (no schema-default noise like keys:[]/raw_hex:"").
check(
  "steps have no default-noise keys",
  !kinds.some((k) => k.includes("timeout_ms")),
  JSON.stringify(kinds),
);
check("has a write step for the typed text", kinds.includes("write"), JSON.stringify(kinds));
check("inserts an idle_ms settle at the pause", kinds.includes("idle_ms"), JSON.stringify(kinds));
check("ends with an assert on final screen", kinds[kinds.length - 1] === "assert", JSON.stringify(kinds));

const writeStep = spec.steps.find((s) => s.write === "ihello world");
check("captures the typed text as a write step", !!writeStep, JSON.stringify(spec.steps));
const escStep = spec.steps.find((s) => s.keys?.length === 1 && s.keys[0] === "escape");
check("captures the escape key as a step", !!escStep, JSON.stringify(spec.steps));
const wqStep = spec.steps.find((s) => s.write === ":wq");
check("captures ':wq' + enter", wqStep?.keys?.includes("enter"), JSON.stringify(wqStep));

console.log(failures === 0 ? "\nSKELETON UNIT TESTS PASSED" : `\n${failures} SKELETON UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
