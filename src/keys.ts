/**
 * Special key name → byte sequence encoding for PTY input.
 *
 * Arrow/home/end sequences depend on DECCKM (application cursor keys mode):
 * full-screen TUIs like vim and less enable it and expect SS3 (`\x1bO_`)
 * instead of CSI (`\x1b[_`) sequences.
 */

const CSI_KEYS: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  backspace: "\x7f",
  space: " ",
  delete: "\x1b[3~",
  insert: "\x1b[2~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  page_up: "\x1b[5~",
  page_down: "\x1b[6~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
  "shift+tab": "\x1b[Z",
};

// SS3 variants used when the application enables DECCKM.
const APP_CURSOR_KEYS: Record<string, string> = {
  up: "\x1bOA",
  down: "\x1bOB",
  right: "\x1bOC",
  left: "\x1bOD",
  home: "\x1bOH",
  end: "\x1bOF",
};

// Codepoints for CSI-u encoding of named keys (fixterms / kitty keyboard
// protocol). Used for modifier chords that have no legacy byte sequence.
const CSI_U_CODES: Record<string, number> = {
  enter: 13,
  tab: 9,
  escape: 27,
  space: 32,
  backspace: 127,
};

export function validKeyNames(): string[] {
  return [...Object.keys(CSI_KEYS), "ctrl+<letter>", "alt+<char>", "<mods>+<key> (CSI-u, e.g. shift+escape)"];
}

// Common spellings of key names seen in the wild, mapped to the canonical name
// so an unknown-key error can point straight at the right one.
const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  newline: "enter",
  del: "delete",
  ins: "insert",
  bs: "backspace",
  spacebar: "space",
  pgup: "page_up",
  pgdn: "page_down",
  pgdown: "page_down",
  pageup: "page_up",
  pagedown: "page_down",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  arrow_up: "up",
  arrow_down: "down",
  arrow_left: "left",
  arrow_right: "right",
};

// Classic Levenshtein distance, small inputs only (key names).
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/** Closest canonical key name for an unknown one, or undefined if nothing is close. */
function suggestKey(name: string): string | undefined {
  const alias = KEY_ALIASES[name];
  if (alias) return alias;
  let best: string | undefined;
  let bestDist = 3; // anything further than 2 edits is a guess, not a suggestion
  for (const known of Object.keys(CSI_KEYS)) {
    const dist = editDistance(name, known);
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  return best;
}

/**
 * Encode a modifier chord as CSI-u: ESC [ code ; mods u. Chords like
 * shift+escape or ctrl+enter have no legacy encoding at all, so CSI-u is the
 * only way to express them; apps speaking the kitty/fixterms protocol decode
 * it, others would have received nothing either way.
 */
function encodeCsiU(mods: string[], base: string): string | undefined {
  const code = CSI_U_CODES[base] ?? (base.length === 1 ? base.codePointAt(0) : undefined);
  if (code === undefined) return undefined;
  let modBits = 0;
  for (const mod of mods) {
    if (mod === "shift") modBits |= 1;
    else if (mod === "alt") modBits |= 2;
    else if (mod === "ctrl") modBits |= 4;
    else return undefined;
  }
  return `\x1b[${code};${1 + modBits}u`;
}

/**
 * Encode a special key name into the byte sequence to write to the PTY.
 * Throws on unknown names so the tool layer can report valid options.
 */
export function encodeKey(name: string, appCursorMode: boolean): string {
  const key = name.toLowerCase().trim();

  if (appCursorMode && key in APP_CURSOR_KEYS) return APP_CURSOR_KEYS[key];
  if (key in CSI_KEYS) return CSI_KEYS[key];

  // Legacy C0 control codes: ctrl + (@ A-Z [ \ ] ^ _) map to 0x00-0x1f via
  // `& 0x1f`. This covers ctrl+letter AND the symbol chords (ctrl+], ctrl+\)
  // that every terminal understands — unlike CSI-u, which needs kitty support.
  const ctrl = key.match(/^ctrl\+(.+)$/);
  if (ctrl) {
    if (ctrl[1] === "space") return "\x00"; // ctrl+space = NUL
    if (ctrl[1].length === 1) {
      const c = ctrl[1].toUpperCase().charCodeAt(0);
      if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 0x1f);
    }
  }

  // alt+<char> is ESC-prefixed on most terminals
  const alt = key.match(/^alt\+(.)$/);
  if (alt) return `\x1b${alt[1]}`;

  // Remaining modifier chords (shift+escape, ctrl+enter, ...) via CSI-u.
  const parts = key.split("+");
  if (parts.length > 1) {
    const encoded = encodeCsiU(parts.slice(0, -1), parts[parts.length - 1]);
    if (encoded !== undefined) return encoded;
  }

  const suggestion = suggestKey(key);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(`Unknown special key "${name}".${hint} Valid keys: ${validKeyNames().join(", ")}`);
}

/** Encode a hex string (whitespace/0x prefixes tolerated) to raw bytes. */
export function decodeHex(hex: string): string {
  const clean = hex.replace(/0x/gi, "").replace(/[\s,]/g, "");
  if (clean.length === 0) return "";
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error(`"${hex}" is not valid hex (need an even number of 0-9a-f digits).`);
  }
  let out = "";
  for (let i = 0; i < clean.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/** The byte string as lowercase hex (used to emit raw_hex for unknown input). */
export function toHex(bytes: string): string {
  return [...bytes].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export type InputSegment = { text: string } | { key: string } | { rawHex: string };

// Byte sequence -> key name, inverting the encode tables. Both arrow forms
// (CSI and SS3) map to the same name; multi-byte sequences are matched
// longest-first so e.g. "\x1b[15~" (f5) wins over a bare "\x1b" (escape).
const SEQUENCE_TO_KEY: Array<[string, string]> = [
  ...Object.entries(CSI_KEYS),
  ...Object.entries(APP_CURSOR_KEYS),
]
  .map(([name, seq]) => [seq, name] as [string, string])
  .sort((a, b) => b[0].length - a[0].length);

const CSI_U_NAME = new Map(Object.entries(CSI_U_CODES).map(([name, code]) => [code, name]));

function csiUToName(data: string, at: number): { name: string; length: number } | undefined {
  // ESC [ <code> ; <mods> u
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point of decoding key sequences.
  const m = /^\x1b\[(\d+);(\d+)u/.exec(data.slice(at));
  if (!m) return undefined;
  const code = Number(m[1]);
  const modBits = Number(m[2]) - 1;
  const base = CSI_U_NAME.get(code) ?? (code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : undefined);
  if (base === undefined) return undefined;
  const mods: string[] = [];
  if (modBits & 4) mods.push("ctrl");
  if (modBits & 2) mods.push("alt");
  if (modBits & 1) mods.push("shift");
  return { name: [...mods, base].join("+"), length: m[0].length };
}

function controlByteToName(ch: string): string | undefined {
  const code = ch.charCodeAt(0);
  if (code === 0x1b || code >= 0x20) return undefined; // ESC handled as sequence; printable is text
  if (code === 0) return "ctrl+space";
  // 0x01-0x1a -> ctrl+a..z; 0x1c-0x1f -> ctrl+\ ] ^ _ ; via 0x40 | code.
  return `ctrl+${String.fromCharCode(0x40 | code).toLowerCase()}`;
}

/**
 * Decode a recorded input byte string back into ordered segments — the inverse
 * of encodeKey. Printable runs become {text}; recognized sequences/control
 * bytes become {key}; anything unrecognized becomes {rawHex}. Used to turn a
 * recording's "i" events into run_test write/keys steps.
 */
export function decodeInput(data: string): InputSegment[] {
  const segments: InputSegment[] = [];
  let text = "";
  const flushText = () => {
    if (text) {
      segments.push({ text });
      text = "";
    }
  };

  let i = 0;
  while (i < data.length) {
    // Longest known multi-byte sequence (arrows, function keys, ...).
    const seq = SEQUENCE_TO_KEY.find(([s]) => s.length > 1 && data.startsWith(s, i));
    if (seq) {
      flushText();
      segments.push({ key: seq[1] });
      i += seq[0].length;
      continue;
    }
    // CSI-u chord (shift+escape, ...).
    if (data.startsWith("\x1b[", i)) {
      const chord = csiUToName(data, i);
      if (chord) {
        flushText();
        segments.push({ key: chord.name });
        i += chord.length;
        continue;
      }
    }
    // An unrecognized escape sequence (e.g. SGR mouse): consume it whole and
    // preserve the bytes as raw_hex rather than mis-splitting into alt+char.
    if (data[i] === "\x1b") {
      const escLen = escapeSequenceLength(data, i);
      if (escLen > 1) {
        flushText();
        segments.push({ rawHex: toHex(data.slice(i, i + escLen)) });
        i += escLen;
        continue;
      }
    }
    const ch = data[i];
    if (ch === "\r") {
      flushText();
      segments.push({ key: "enter" });
      i++;
    } else if (ch === "\t") {
      flushText();
      segments.push({ key: "tab" });
      i++;
    } else if (ch === "\x7f") {
      flushText();
      segments.push({ key: "backspace" });
      i++;
    } else if (ch === "\x1b") {
      // A lone ESC not starting any sequence: bare escape, or alt+<char>.
      const next = data[i + 1];
      if (next && next >= "\x20" && next < "\x7f") {
        flushText();
        segments.push({ key: `alt+${next}` });
        i += 2;
      } else {
        flushText();
        segments.push({ key: "escape" });
        i++;
      }
    } else {
      const ctrlName = controlByteToName(ch);
      if (ctrlName) {
        flushText();
        segments.push({ key: ctrlName });
      } else {
        text += ch;
      }
      i++;
    }
  }
  flushText();
  return segments;
}

// Length of a full ANSI escape sequence starting at `at`, or 1 if `at` is a
// lone ESC. Handles CSI (ESC [ ... final), SS3 (ESC O final), and OSC
// (ESC ] ... BEL|ST). Used to consume unrecognized sequences as raw_hex.
function escapeSequenceLength(data: string, at: number): number {
  if (data[at] !== "\x1b" || at + 1 >= data.length) return 1;
  const kind = data[at + 1];
  if (kind === "[") {
    let j = at + 2;
    while (j < data.length && data[j] >= "\x30" && data[j] <= "\x3f") j++; // params
    while (j < data.length && data[j] >= "\x20" && data[j] <= "\x2f") j++; // intermediates
    if (j < data.length && data[j] >= "\x40" && data[j] <= "\x7e") return j - at + 1; // final
    return 1;
  }
  if (kind === "O") {
    return at + 2 < data.length && data[at + 2] >= "\x40" && data[at + 2] <= "\x7e" ? 3 : 1;
  }
  if (kind === "]") {
    for (let j = at + 2; j < data.length; j++) {
      if (data[j] === "\x07") return j - at + 1; // BEL terminator
      if (data[j] === "\x1b" && data[j + 1] === "\\") return j - at + 2; // ST terminator
    }
    return 1;
  }
  return 1;
}
