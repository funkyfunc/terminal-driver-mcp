// Unit tests for shell-integration snippet selection.
import { shellIntegrationSnippet } from "../dist/shell-integration.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
}

check(
  "zsh snippet uses add-zsh-hook + OSC 133",
  /add-zsh-hook/.test(shellIntegrationSnippet("/bin/zsh") ?? "") &&
    /133/.test(shellIntegrationSnippet("/bin/zsh") ?? ""),
);
check(
  "bash snippet uses PS0 + PROMPT_COMMAND",
  /PS0=/.test(shellIntegrationSnippet("/usr/bin/bash") ?? "") &&
    /PROMPT_COMMAND/.test(shellIntegrationSnippet("/usr/bin/bash") ?? ""),
);
check(
  "sh maps to the bash snippet",
  shellIntegrationSnippet("/bin/sh") === shellIntegrationSnippet("/bin/bash"),
);
check("unknown shell returns undefined", shellIntegrationSnippet("/usr/bin/fish") === undefined);

console.log(failures === 0 ? "\nSHELL UNIT TESTS PASSED" : `\n${failures} SHELL UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
