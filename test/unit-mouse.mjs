// Unit tests for SGR mouse encoding. Agent coordinates are 0-based; SGR is
// 1-based, so a click at (0,0) reports column 1, row 1.
import { encodeClick, encodeDrag, encodeWheel } from "../dist/mouse.js";

let failures = 0;
function eq(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) {
    failures++;
    console.log(`    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Left click at row 2, col 5 -> SGR press+release at col 6, row 3.
eq("left click press+release", encodeClick("left", 2, 5), "\x1b[<0;6;3M\x1b[<0;6;3m");
// Right click uses button code 2.
eq("right click", encodeClick("right", 0, 0), "\x1b[<2;1;1M\x1b[<2;1;1m");
// Middle click uses button code 1.
eq("middle click", encodeClick("middle", 0, 0), "\x1b[<1;1;1M\x1b[<1;1;1m");
// Double click = two press+release pairs.
eq("double click", encodeClick("left", 0, 0, 2), "\x1b[<0;1;1M\x1b[<0;1;1m\x1b[<0;1;1M\x1b[<0;1;1m");
// Drag: press at start, motion (button+32) at end, release at end.
eq("drag left (0,0)->(3,4)", encodeDrag("left", 0, 0, 3, 4), "\x1b[<0;1;1M\x1b[<32;5;4M\x1b[<0;5;4m");
// Wheel: button 64 up / 65 down, press-only (no release), one event per tick.
eq("wheel up", encodeWheel("wheel_up", 2, 5), "\x1b[<64;6;3M");
eq("wheel down x2 ticks", encodeWheel("wheel_down", 0, 0, 2), "\x1b[<65;1;1M\x1b[<65;1;1M");

console.log(failures === 0 ? "\nMOUSE UNIT TESTS PASSED" : `\n${failures} MOUSE UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
