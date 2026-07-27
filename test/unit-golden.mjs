// Unit tests for golden snapshots and the screen diff — pure, deterministic.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenDiff } from "../dist/diff.js";
import { applyMasks, matchGolden } from "../dist/golden.js";

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`    ${detail}`);
  }
}

// applyMasks
check(
  "applyMasks replaces regex matches",
  applyMasks("time=12:34:56 ok", ["\\d\\d:\\d\\d:\\d\\d"]) === "time=«MASKED» ok",
);

// screenDiff
const diff = screenDiff("a\nB\nc", "a\nX\nc");
check(
  "screenDiff shows only the differing row",
  diff.includes("row 1:") && diff.includes("- B") && diff.includes("+ X") && !diff.includes("row 0"),
  diff,
);

// matchGolden lifecycle
const dir = mkdtempSync(join(tmpdir(), "tdmcp-golden-"));
try {
  const base = { screensDir: dir, testName: "t", snapshotName: "s", masks: [] };

  const missing = matchGolden({ ...base, actual: "hello", update: false });
  check(
    "missing golden without --update fails",
    !missing.ok && /Run with --update/.test(missing.detail),
    missing.detail,
  );

  const created = matchGolden({ ...base, actual: "hello", update: true });
  check("--update writes the golden and passes", created.ok, created.detail);
  check(
    "golden file written",
    readFileSync(join(dir, "t.s.txt"), "utf8").startsWith("hello"),
    "file missing",
  );

  const matched = matchGolden({ ...base, actual: "hello", update: false });
  check("matching actual passes", matched.ok, matched.detail);

  const mismatch = matchGolden({ ...base, actual: "goodbye", update: false });
  check("mismatch fails with a diff", !mismatch.ok && mismatch.detail.includes("row 0"), mismatch.detail);

  const maskedMatch = matchGolden({
    screensDir: dir,
    testName: "t",
    snapshotName: "masked",
    masks: ["\\d+"],
    actual: "count=1",
    update: true,
  });
  check("masked golden created", maskedMatch.ok, maskedMatch.detail);
  const maskedRerun = matchGolden({
    screensDir: dir,
    testName: "t",
    snapshotName: "masked",
    masks: ["\\d+"],
    actual: "count=999",
    update: false,
  });
  check("masked region ignores volatile change", maskedRerun.ok, maskedRerun.detail);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nGOLDEN UNIT TESTS PASSED" : `\n${failures} GOLDEN UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
