// Unit tests for the JUnit/JSON reporters — pure functions over TestResult.
import { jsonReport, junitReport } from "../dist/report.js";

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`    ${detail}`);
  }
}

const results = [
  {
    file: "a.json",
    result: {
      name: "suite A",
      ok: false,
      steps: [
        { index: 0, desc: "wait /x/", ok: true, detail: "matched", elapsedMs: 10, group: "setup" },
        {
          index: 1,
          desc: 'assert "y"',
          ok: false,
          detail: 'FAIL: "y" not found\ncontext',
          elapsedMs: 5,
          group: "checks",
          soft: true,
        },
      ],
    },
  },
];

const xml = junitReport(results);
check(
  "junit has testsuites with totals",
  xml.includes('<testsuites name="terminal-driver-mcp" tests="2" failures="1">'),
  xml.slice(0, 120),
);
check("junit has a testcase per step", (xml.match(/<testcase /g) || []).length === 2, xml);
check("junit emits a failure element", xml.includes("<failure ") && xml.includes("not found"), "no failure");
check("junit escapes quotes in names", xml.includes("&quot;y&quot;"), "quotes not escaped");
check("junit puts the group in the classname", xml.includes("suite A › checks"), "group not in classname");
check("junit marks a soft failure in the message", xml.includes("[soft]"), "soft not marked");

const json = JSON.parse(jsonReport(results));
check(
  "json is an array of file results",
  Array.isArray(json) && json[0].name === "suite A" && json[0].ok === false,
  JSON.stringify(json[0]),
);
check("json omits heavy cell captures", !("screen" in json[0].steps[0]), "screen leaked into json");
check(
  "json carries group and soft",
  json[0].steps[0].group === "setup" && json[0].steps[1].soft === true,
  JSON.stringify(json[0].steps),
);

// Flaky metadata (from --retries) surfaces at the file level.
const flakyJson = JSON.parse(
  jsonReport([
    {
      file: "b.json",
      attempts: 2,
      flaky: true,
      result: {
        name: "suite B",
        ok: true,
        steps: [{ index: 0, desc: "wait /z/", ok: true, detail: "", elapsedMs: 1 }],
      },
    },
  ]),
);
check(
  "json reports flaky attempts",
  flakyJson[0].flaky === true && flakyJson[0].attempts === 2,
  JSON.stringify(flakyJson[0]),
);

console.log(failures === 0 ? "\nREPORT UNIT TESTS PASSED" : `\n${failures} REPORT UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
