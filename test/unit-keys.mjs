// Unit tests for key encoding: legacy C0 control codes for symbol chords
// (ctrl+], ctrl+\) must use the byte every terminal understands, not CSI-u.
import { encodeKey } from "../dist/keys.js";

let failures = 0;
function eq(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) {
    failures++;
    const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
    console.log(
      `    expected ${JSON.stringify(expected)} (${hex(expected)}), got ${JSON.stringify(actual)} (${hex(actual)})`,
    );
  }
}

// Legacy control codes (work in every terminal, unlike CSI-u).
eq("ctrl+a = 0x01", encodeKey("ctrl+a", false), "\x01");
eq("ctrl+r = 0x12", encodeKey("ctrl+r", false), "\x12");
eq("ctrl+] = 0x1d", encodeKey("ctrl+]", false), "\x1d");
eq("ctrl+\\ = 0x1c", encodeKey("ctrl+\\", false), "\x1c");
eq("ctrl+^ = 0x1e", encodeKey("ctrl+^", false), "\x1e");
eq("ctrl+space = 0x00", encodeKey("ctrl+space", false), "\x00");

// Arrows depend on DECCKM (application cursor mode).
eq("up (DECCKM off) = CSI", encodeKey("up", false), "\x1b[A");
eq("up (DECCKM on) = SS3", encodeKey("up", true), "\x1bOA");

// Modifier chords with no legacy encoding fall back to CSI-u.
eq("shift+escape = CSI-u 27;2u", encodeKey("shift+escape", false), "\x1b[27;2u");
eq("alt+x = ESC x", encodeKey("alt+x", false), "\x1bx");

// Unknown names still throw.
let threw = false;
try {
  encodeKey("nonsense", false);
} catch {
  threw = true;
}
console.log(`${threw ? "PASS" : "FAIL"}: unknown key name throws`);
if (!threw) failures++;

// Near-miss names get a did-you-mean pointing at the canonical key.
function suggestionFor(name) {
  try {
    encodeKey(name, false);
    return "<no throw>";
  } catch (err) {
    const m = String(err.message).match(/Did you mean "([^"]+)"/);
    return m ? m[1] : "<no suggestion>";
  }
}
eq("alias pgup suggests page_up", suggestionFor("pgup"), "page_up");
eq("alias esc suggests escape", suggestionFor("esc"), "escape");
eq("alias return suggests enter", suggestionFor("return"), "enter");
eq("typo 'entr' suggests enter", suggestionFor("entr"), "enter");
eq("alias arrow_up suggests up", suggestionFor("arrow_up"), "up");

console.log(failures === 0 ? "\nKEY UNIT TESTS PASSED" : `\n${failures} KEY UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
