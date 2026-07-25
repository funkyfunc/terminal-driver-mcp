/**
 * Convert an asciicast v2 recording into a run_test JSON skeleton — the
 * "drive it once by hand, get a regression test" workflow. Recorded input
 * ("i") events become write/keys steps (inverting our own key encoding),
 * resizes ("r") become resize steps, pauses become idle_ms settle steps, and
 * the final rendered screen becomes a suggested assert. The output is a draft
 * the human refines (tightening settles into precise `wait:` regexes, adding
 * asserts), and is always a valid, runnable TestSpec.
 */
import xterm from "@xterm/headless";
import { decodeInput, type InputSegment } from "./keys.js";
import { type TestDraft, TestSchema } from "./runner.js";
import { snapshotText } from "./screen.js";

const { Terminal } = xterm;

// Insert a settle step when the human paused at least this long before acting.
const GAP_THRESHOLD_S = 0.2;

interface CastHeader {
  width: number;
  height: number;
  title?: string;
}
type CastEvent = [number, string, string];

export function parseCast(text: string): { header: CastHeader; events: CastEvent[] } {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("empty recording");
  const header = JSON.parse(lines[0]) as CastHeader;
  if (typeof header.width !== "number" || typeof header.height !== "number") {
    throw new Error("not an asciicast v2 file (missing width/height in header)");
  }
  const events: CastEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const e = JSON.parse(lines[i]);
    if (Array.isArray(e) && e.length === 3) events.push([e[0], e[1], e[2]]);
  }
  return { header, events };
}

// A run_test step is an untyped object here; TestSchema validates it at the end.
type Step = Record<string, unknown>;

// Turn one "i" event's decoded segments into ordered steps, coalescing a text
// run plus the keys/raw that immediately follow into a single write step.
function segmentsToSteps(segments: InputSegment[]): Step[] {
  const steps: Step[] = [];
  let current: { write?: string; keys: string[]; raw_hex?: string } | null = null;
  const flush = () => {
    if (!current) return;
    const step: Step = {};
    if (current.write) step.write = current.write;
    if (current.keys.length) step.keys = current.keys;
    if (current.raw_hex) step.raw_hex = current.raw_hex;
    steps.push(step);
    current = null;
  };

  for (const seg of segments) {
    if ("text" in seg) {
      // A new text run starts a fresh step (keys already attached to the prior one).
      if (current && (current.keys.length || current.raw_hex)) flush();
      current ??= { keys: [] };
      current.write = (current.write ?? "") + seg.text;
    } else if ("key" in seg) {
      current ??= { keys: [] };
      current.keys.push(seg.key);
    } else {
      current ??= { keys: [] };
      current.raw_hex = (current.raw_hex ?? "") + seg.rawHex;
    }
  }
  flush();
  return steps;
}

/** Render all output ("o") events into a headless terminal and return the final screen. */
async function finalScreen(events: CastEvent[], cols: number, rows: number): Promise<string> {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  for (const [, type, data] of events) {
    if (type === "o") term.write(data);
  }
  return snapshotText({ term } as Parameters<typeof snapshotText>[0]);
}

export async function recordingToSkeleton(castText: string, name?: string): Promise<TestDraft> {
  const { header, events } = parseCast(castText);
  const steps: Step[] = [];
  let lastActionTime = 0;

  for (const [time, type, data] of events) {
    if (type !== "i" && type !== "r") continue; // "o"/"q" drive timing, not steps

    // A pause before this action → the human waited for the app to respond.
    if (time - lastActionTime >= GAP_THRESHOLD_S && steps.length > 0) {
      steps.push({ idle_ms: 150 });
    }
    lastActionTime = time;

    if (type === "r") {
      const m = /^(\d+)x(\d+)$/.exec(data);
      if (m) steps.push({ resize: [Number(m[1]), Number(m[2])] });
    } else {
      steps.push(...segmentsToSteps(decodeInput(data)));
    }
  }

  // A trailing assert on the last non-blank line as a starting checkpoint.
  const screen = await finalScreen(events, header.width, header.height);
  const lastLine = screen
    .split("\n")
    .reverse()
    .find((l) => l.trim() !== "");
  if (lastLine) steps.push({ assert: lastLine.trim() });

  const spec: TestDraft = {
    name: name ?? header.title ?? "recorded test",
    ...(header.title ? { command: header.title } : {}),
    cols: header.width,
    rows: header.height,
    steps: (steps.length > 0 ? steps : [{ idle_ms: 100 }]) as TestDraft["steps"],
  };

  // Validate that the skeleton is a runnable test, but return the clean object
  // (without schema defaults) so the emitted JSON stays readable.
  TestSchema.parse(spec);
  return spec;
}
