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

  const ctrl = key.match(/^ctrl\+([a-z])$/);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);

  // alt+<char> is ESC-prefixed on most terminals
  const alt = key.match(/^alt\+(.)$/);
  if (alt) return `\x1b${alt[1]}`;

  // Remaining modifier chords (shift+escape, ctrl+enter, ...) via CSI-u.
  const parts = key.split("+");
  if (parts.length > 1) {
    const encoded = encodeCsiU(parts.slice(0, -1), parts[parts.length - 1]);
    if (encoded !== undefined) return encoded;
  }

  throw new Error(`Unknown special key "${name}". Valid keys: ${validKeyNames().join(", ")}`);
}
