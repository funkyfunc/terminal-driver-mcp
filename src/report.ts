/**
 * Test reporters. JUnit XML is the lingua franca every CI (Jenkins, GitLab,
 * GitHub, Azure) understands — the difference between "a tool I run locally"
 * and "a tool in the pipeline". JSON is the machine-readable form.
 */
import type { TestResult } from "./runner.js";

export interface FileResult {
  file: string;
  result: TestResult;
  attempts?: number; // total attempts run (>1 means it was retried)
  flaky?: boolean; // failed at least once but eventually passed within the retry budget
}

const xmlEscape = (s: string): string =>
  s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );

/** JUnit XML: one <testsuite> per test, one <testcase> per step. */
export function junitReport(results: FileResult[]): string {
  const suites = results.map(({ file, result }) => {
    const failures = result.steps.filter((s) => !s.ok).length;
    const cases = result.steps
      .map((s) => {
        const time = (s.elapsedMs / 1000).toFixed(3);
        // Group label becomes the JUnit classname suffix (rendered as a nested
        // node by most CI viewers); soft failures are annotated in the message.
        const classname = xmlEscape(s.group ? `${result.name} › ${s.group}` : result.name);
        const name = xmlEscape(`step ${s.index + 1}: ${s.desc}`);
        const open = `      <testcase name="${name}" classname="${classname}" time="${time}">`;
        if (s.ok) return `${open}</testcase>`;
        const msg = xmlEscape(`${s.soft ? "[soft] " : ""}${s.detail.split("\n")[0]}`);
        return `${open}\n        <failure message="${msg}">${xmlEscape(s.detail)}</failure>\n      </testcase>`;
      })
      .join("\n");
    return `  <testsuite name="${xmlEscape(result.name)}" tests="${result.steps.length}" failures="${failures}" file="${xmlEscape(file)}">\n${cases}\n  </testsuite>`;
  });
  const totalTests = results.reduce((n, r) => n + r.result.steps.length, 0);
  const totalFail = results.reduce((n, r) => n + r.result.steps.filter((s) => !s.ok).length, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="terminal-driver-mcp" tests="${totalTests}" failures="${totalFail}">\n${suites.join("\n")}\n</testsuites>\n`;
}

/** Machine-readable JSON: the results verbatim, minus the heavy per-step cell captures. */
export function jsonReport(results: FileResult[]): string {
  const trimmed = results.map(({ file, result, attempts, flaky }) => ({
    file,
    name: result.name,
    ok: result.ok,
    ...(attempts && attempts > 1 ? { attempts } : {}),
    ...(flaky ? { flaky } : {}),
    steps: result.steps.map(({ index, desc, ok, detail, elapsedMs, group, soft }) => ({
      index,
      desc,
      ok,
      detail,
      elapsedMs,
      ...(group ? { group } : {}),
      ...(soft ? { soft } : {}),
    })),
  }));
  return `${JSON.stringify(trimmed, null, 2)}\n`;
}
