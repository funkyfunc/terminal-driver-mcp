/**
 * Synchronization primitives: agents must never type into a screen that is
 * still mutating. These helpers poll the emulator until a pattern appears or
 * output quiesces, always returning the final screen so the agent can see
 * what actually happened — including on timeout.
 */
import { snapshotText } from "./screen.js";
import { SCROLLBACK, type TerminalSession } from "./session-manager.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest run of literal characters in a regex source (metacharacters split runs). */
function longestLiteralFragment(source: string): string {
  const parts = source.split(/[\\^$.*+?()[\]{}|]+/);
  return parts.reduce((a, b) => (b.length > a.length ? b : a), "");
}

/**
 * How much of `fragment` appears in `line`: the full fragment, or its longest
 * prefix/suffix (catches truncated/elided content — the common wrong-regex
 * case where the real screen line is close but not quite the pattern).
 */
function partialMatchScore(line: string, fragment: string): number {
  if (line.includes(fragment)) return fragment.length;
  for (let k = fragment.length - 1; k >= 4; k--) {
    if (line.includes(fragment.slice(0, k)) || line.includes(fragment.slice(fragment.length - k))) {
      return k;
    }
  }
  return 0;
}

/**
 * On a pattern-wait timeout, probe the near-misses an agent can actually act
 * on: the pattern already scrolled off-screen, it differs only by case, or a
 * screen line comes close to the pattern's literal part (wrong/overspecified
 * regex). Returns "" when nothing applies, so the hint costs tokens only when
 * useful.
 */
async function patternTimeoutHint(session: TerminalSession, pattern: RegExp): Promise<string> {
  const withScrollback = await snapshotText(session, SCROLLBACK);
  if (pattern.test(withScrollback)) {
    return " Note: the pattern DOES match in scrollback — it likely scrolled off-screen; view it with session_read scrollback_lines.";
  }
  const screen = await snapshotText(session);
  try {
    const insensitive = new RegExp(pattern.source, `${pattern.flags}i`);
    if (insensitive.test(screen)) {
      return " Note: the pattern matches ignoring case — check the capitalization.";
    }
  } catch {
    /* flags already had i, or exotic pattern — no hint */
  }
  const fragment = longestLiteralFragment(pattern.source).slice(0, 60);
  if (fragment.length >= 4) {
    let best: { row: number; line: string; score: number } | undefined;
    for (const [row, line] of screen.split("\n").entries()) {
      const score = partialMatchScore(line, fragment);
      if (score > (best?.score ?? 0)) best = { row, line, score };
    }
    if (best && best.score >= Math.max(4, Math.ceil(fragment.length / 2))) {
      return ` Note: no match, but row ${best.row} looks close: "${best.line.trim()}" — check the pattern against it.`;
    }
  }
  return "";
}

const IDLE_TIMEOUT_TIP =
  " The app may be redrawing continuously (spinner, clock, progress bar); if you know what should appear, wait for that pattern instead.";

// Frame-tear guard: a pattern often matches mid-repaint, and returning that
// torn frame shows stale cells that read as app bugs. After a match, let
// output go briefly quiet (measured from the last byte, so an already-stable
// screen adds ~no latency) before taking the snapshot that gets returned.
// The cap keeps continuously-animating UIs from stalling the wait. idleMs
// matches the afterWrite settle; real frame tears are sub-16ms, so 80ms
// bridges them with margin.
const AFTER_MATCH_SETTLE = { idleMs: 80, capMs: 500 };

async function settledSnapshot(session: TerminalSession): Promise<string> {
  const deadline = Date.now() + AFTER_MATCH_SETTLE.capMs;
  while (!session.exited && Date.now() < deadline) {
    if (Date.now() - session.lastDataAt >= AFTER_MATCH_SETTLE.idleMs) break;
    await sleep(15);
  }
  return snapshotText(session);
}

export interface WaitResult {
  ok: boolean;
  elapsedMs: number;
  screen: string;
  message: string;
}

/**
 * Poll until `pattern` matches the screen — or, with absent=true, until it
 * stops matching (the temporal counterpart of an absence assertion: "delete
 * the row, then wait for it to disappear before asserting"). Either way the
 * final screen is returned, including on timeout.
 *
 * With `freshBaseline` (the pre-action screen's lines), only rows that DIFFER
 * from the baseline count for matching — content that was already on screen
 * before the action can never satisfy the wait. The stale-match antidote for
 * expect_fresh.
 */
export async function waitForPattern(
  session: TerminalSession,
  pattern: RegExp,
  timeoutMs: number,
  absent = false,
  freshBaseline?: string[],
): Promise<WaitResult> {
  const start = Date.now();
  let sessionEnded = false;
  const goal = absent ? `${pattern} to disappear` : pattern;
  const changedRows = (screen: string): string =>
    screen
      .split("\n")
      .filter((line, i) => line !== freshBaseline?.[i])
      .join("\n");
  const isMatch = (screen: string): boolean =>
    freshBaseline && !absent ? pattern.test(changedRows(screen)) : pattern.test(screen);

  for (;;) {
    const screen = await snapshotText(session);
    const elapsedMs = Date.now() - start;

    // Satisfied when the pattern is present (normal) or gone (absent).
    if (isMatch(screen) !== absent) {
      const how = absent ? `no longer present after ${elapsedMs}ms` : `matched after ${elapsedMs}ms`;
      // Return the settled frame, not the possibly-torn one that matched. If
      // settling changed the answer, say so rather than return a confusing mix.
      const settled = await settledSnapshot(session);
      let note = "";
      if (isMatch(settled) === absent) {
        note = absent
          ? " Note: the pattern REAPPEARED while the frame settled — the app may redraw it periodically."
          : " Note: the matched content disappeared while the frame settled (it was transient); the returned screen is the settled one.";
      }
      return { ok: true, elapsedMs, screen: settled, message: `Pattern ${pattern} ${how}.${note}` };
    }
    // One final snapshot is taken after exit before giving up, since the
    // last output may have arrived alongside process termination.
    if (sessionEnded) {
      const why = absent ? `still matching ${pattern}` : `without matching ${pattern}`;
      return {
        ok: false,
        elapsedMs,
        screen,
        message: `Session exited (code ${session.exitCode}) ${why}.`,
      };
    }
    if (elapsedMs >= timeoutMs) {
      let hint: string;
      if (!absent && freshBaseline && pattern.test(screen)) {
        hint =
          " Note: the pattern matches only content that was ALREADY on screen before the action — " +
          "expect_fresh excluded those unchanged rows, so the action likely did not produce the expected output.";
      } else {
        hint = absent ? "" : await patternTimeoutHint(session, pattern);
      }
      return {
        ok: false,
        elapsedMs,
        screen,
        message: `Timed out after ${timeoutMs}ms waiting for ${goal}.${hint}`,
      };
    }
    sessionEnded = session.exited;
    await sleep(50);
  }
}

/**
 * Byte-silence idle detection: resolves when no PTY bytes arrive for idleMs.
 * Best-effort — apps that continuously animate (spinners, progress bars) or
 * emit periodic no-op sequences never go silent; callers should prefer
 * waitForPattern when a concrete target is known.
 */
export async function waitForIdle(
  session: TerminalSession,
  idleMs: number,
  timeoutMs: number,
): Promise<WaitResult> {
  const start = Date.now();

  for (;;) {
    const quietFor = Date.now() - session.lastDataAt;
    const elapsedMs = Date.now() - start;

    if (quietFor >= idleMs || session.exited) {
      const screen = await snapshotText(session);
      const message = session.exited
        ? `Session exited (code ${session.exitCode}); output stable.`
        : `Terminal idle (no output for ${quietFor}ms).`;
      return { ok: true, elapsedMs, screen, message };
    }
    if (elapsedMs >= timeoutMs) {
      const screen = await snapshotText(session);
      return {
        ok: false,
        elapsedMs,
        screen,
        message: `Timed out after ${timeoutMs}ms: output never stayed idle for ${idleMs}ms.${IDLE_TIMEOUT_TIP}`,
      };
    }
    await sleep(25);
  }
}

/**
 * Screen-stability detection: resolves when the rendered text grid is
 * unchanged for stableMs. More robust than byte-silence for apps that emit
 * constant bytes without visual change (cursor pings, identical redraws),
 * but still defeated by true animations.
 */
export async function waitForStableScreen(
  session: TerminalSession,
  stableMs: number,
  timeoutMs: number,
): Promise<WaitResult> {
  const start = Date.now();
  let last = await snapshotText(session);
  let lastChangeAt = Date.now();

  for (;;) {
    const elapsedMs = Date.now() - start;
    const stableFor = Date.now() - lastChangeAt;

    if (stableFor >= stableMs || session.exited) {
      const message = session.exited
        ? `Session exited (code ${session.exitCode}); screen stable.`
        : `Screen unchanged for ${stableFor}ms.`;
      return { ok: true, elapsedMs, screen: last, message };
    }
    if (elapsedMs >= timeoutMs) {
      return {
        ok: false,
        elapsedMs,
        screen: last,
        message: `Timed out after ${timeoutMs}ms: screen never held still for ${stableMs}ms.${IDLE_TIMEOUT_TIP}`,
      };
    }
    await sleep(Math.min(50, stableMs));
    const current = await snapshotText(session);
    if (current !== last) {
      last = current;
      lastChangeAt = Date.now();
    }
  }
}

/**
 * Wait until output has been quiet for idleMs, measured from no earlier than
 * `since`. Unlike waitForIdle, this always waits at least idleMs even when no
 * output has arrived yet — e.g. an echo still in flight from input just
 * written — so it reliably holds for the app to ingest and render that input.
 */
export async function waitForIdleSince(
  session: TerminalSession,
  since: number,
  idleMs: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const quietFor = Date.now() - Math.max(session.lastDataAt, since);
    if (session.exited || quietFor >= idleMs) return;
    if (Date.now() - start >= timeoutMs) return;
    await sleep(25);
  }
}

/** Resolve when the session's process exits, or report false on timeout. */
export async function waitForExit(session: TerminalSession, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!session.exited) {
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(25);
  }
  return true;
}
