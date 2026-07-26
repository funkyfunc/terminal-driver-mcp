// Unit test for PNG rendering: a cell snapshot renders to a valid, non-trivial
// PNG using the bundled font (deterministic across machines).
import xterm from "@xterm/headless";
import { renderPng } from "../dist/render.js";
import { snapshotCells } from "../dist/screen.js";

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`    ${detail}`);
  }
}

const term = new xterm.Terminal({ cols: 40, rows: 6, scrollback: 1000, allowProposedApi: true });
// Includes symbols outside JetBrains Mono (✳ ⦿) to exercise the Noto fallback.
await new Promise((r) => term.write("\x1b[31mERROR\x1b[0m \x1b[1mok\x1b[0m box:─┐ ✳ ⦿ ●", r));
const png = renderPng(await snapshotCells({ term }));

check(
  "renders a PNG (magic bytes)",
  png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
  png.subarray(0, 8).toString("hex"),
);
check("PNG is non-trivial in size", png.length > 500, `${png.length} bytes`);

console.log(failures === 0 ? "\nRENDER UNIT TESTS PASSED" : `\n${failures} RENDER UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
