// Unit test for the HTML trace viewer: renders a run to a self-contained,
// well-formed page with per-step screens and defaults to the failing step.
import { renderTrace } from "../dist/trace.js";

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`    ${detail}`);
  }
}

const cells = (text, style = {}) => ({
  cols: 20,
  rows: 2,
  cursor: { row: 0, col: 0 },
  lines: [{ y: 0, runs: [{ text, ...style }] }],
});

const result = {
  name: "trace unit",
  ok: false,
  steps: [
    {
      index: 0,
      desc: "wait /ready/",
      ok: true,
      detail: "matched",
      elapsedMs: 12,
      screen: cells("ready", { fg: { palette: 2 } }),
    },
    {
      index: 1,
      desc: 'assert "nope"',
      ok: false,
      detail: 'FAIL: "nope" not found',
      elapsedMs: 5,
      screen: cells("ready", { bold: true }),
    },
  ],
};

const html = renderTrace(result);
check(
  "well-formed HTML document",
  html.startsWith("<!doctype html>") && html.trimEnd().endsWith("</html>"),
  html.slice(0, 40),
);
check(
  "self-contained (no external script/style URLs)",
  !/(src|href)=["']https?:/.test(html),
  "external ref found",
);
check(
  "includes both step descriptions",
  html.includes("wait /ready/") && html.includes('assert "nope"'),
  "steps missing",
);
check("renders a colored screen span", html.includes("color:#00cd00"), "no green span");
check("shows the failure detail", html.includes("not found"), "no detail");
check("defaults to the failing step (index 1)", html.includes("show(1)"), "wrong default step");

// Grouping + soft assertions: a named section renders a group header, and a
// soft failure is marked distinctly (⚠) rather than as a hard failure (✗).
const grouped = {
  name: "grouped run",
  ok: false,
  steps: [
    {
      index: 0,
      desc: "wait /login/",
      ok: true,
      detail: "ok",
      elapsedMs: 3,
      group: "auth",
      screen: cells("x"),
    },
    {
      index: 1,
      desc: 'assert "welcome"',
      ok: false,
      detail: "FAIL: soft miss",
      elapsedMs: 4,
      group: "auth",
      soft: true,
      screen: cells("x"),
    },
  ],
};
const gh = renderTrace(grouped);
check("renders a group header", gh.includes('<div class="group">auth</div>'), "no group header");
check("group header appears once for consecutive steps", (gh.match(/class="group"/g) || []).length === 1, gh);
check("marks the soft failure with ⚠", gh.includes("⚠") && gh.includes("failed (soft)"), "no soft mark");
check("soft failure is not styled as a hard failure", gh.includes('class="step soft"'), "wrong soft class");

console.log(failures === 0 ? "\nTRACE UNIT TESTS PASSED" : `\n${failures} TRACE UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
