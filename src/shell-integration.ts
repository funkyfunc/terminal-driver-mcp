/**
 * Shell integration: one-line snippets that make bash/zsh emit OSC 133
 * semantic prompt markers (FTCS):
 *   ESC ] 133 ; A ST   prompt start
 *   ESC ] 133 ; B ST   command start (end of prompt)
 *   ESC ] 133 ; C ST   command output begins (pre-execution)
 *   ESC ] 133 ; D ; N  command finished, exit code N
 * The server parses these to expose per-command output + exit code without
 * guessing when a command finished. Injected into an interactive shell at
 * session start when shellIntegration is enabled.
 */

// zsh: precmd/preexec hooks emit C/D; A/B are wrapped into PS1.
const ZSH = [
  "autoload -Uz add-zsh-hook",
  "__td_pe(){ print -n '\\e]133;C\\a' }",
  '__td_pc(){ local s=$?; print -n "\\e]133;D;$s\\a" }',
  "add-zsh-hook preexec __td_pe",
  "add-zsh-hook precmd __td_pc",
  "PS1=$'%{\\e]133;A\\a%}'$PS1$'%{\\e]133;B\\a%}'",
].join("; ");

// bash (4.4+): PS0 emits C before each command, PROMPT_COMMAND emits D with the
// exit code, PS1 is wrapped with A/B.
const BASH = [
  "PS0=$'\\e]133;C\\a'",
  'PROMPT_COMMAND=\'printf "\\e]133;D;%s\\a" "$?"\'',
  "PS1='\\[\\e]133;A\\a\\]'\"$PS1\"'\\[\\e]133;B\\a\\]'",
].join("; ");

/** The integration one-liner for a shell (by basename), or undefined if unsupported. */
export function shellIntegrationSnippet(shellPath: string): string | undefined {
  const base = shellPath.split("/").pop() ?? "";
  if (base === "zsh") return ZSH;
  if (base === "bash" || base === "sh") return BASH;
  return undefined;
}
