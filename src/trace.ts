/**
 * Self-contained HTML trace of a test run — the terminal equivalent of
 * Playwright's trace viewer. A step list on the left; the rendered screen
 * captured after each step on the right, click to time-travel. Everything is
 * inlined (no external assets, CSP-safe), so a failing CI run can attach one
 * `trace.html` that shows exactly what the screen looked like at each step.
 */
import { DEFAULT_BG, DEFAULT_FG, resolveColor } from "./colors.js";
import type { TestResult } from "./runner.js";
import type { CellSnapshot } from "./screen.js";

const esc = (s: string): string =>
  s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

function screenToHtml(snap: CellSnapshot | undefined): string {
  if (!snap) return '<div class="noscreen">(no screen captured)</div>';
  const rows = snap.lines.map((line) => {
    const spans = line.runs
      .map((run) => {
        const fg = resolveColor(run.inverse ? run.bg : run.fg, run.inverse ? DEFAULT_BG : DEFAULT_FG);
        const bg = resolveColor(run.inverse ? run.fg : run.bg, run.inverse ? DEFAULT_FG : DEFAULT_BG);
        const css = [
          `color:${fg}`,
          run.bg !== undefined || run.inverse ? `background:${bg}` : "",
          run.bold ? "font-weight:bold" : "",
          run.italic ? "font-style:italic" : "",
          run.underline ? "text-decoration:underline" : "",
          run.strikethrough ? "text-decoration:line-through" : "",
          run.dim ? "opacity:.6" : "",
        ]
          .filter(Boolean)
          .join(";");
        return `<span style="${css}">${esc(run.text)}</span>`;
      })
      .join("");
    return `<div class="row">${spans || "&nbsp;"}</div>`;
  });
  return `<div class="screen">${rows.join("")}</div>`;
}

/** Render a completed run (with per-step screen captures) to a standalone HTML string. */
export function renderTrace(result: TestResult): string {
  const failIdx = result.steps.findIndex((s) => !s.ok);
  const selected = failIdx >= 0 ? failIdx : result.steps.length - 1;

  let lastGroup: string | undefined;
  const buttons = result.steps
    .map((s, i) => {
      // A group header row precedes the first step of each named section.
      const header = s.group !== lastGroup && s.group ? `<div class="group">${esc(s.group)}</div>` : "";
      lastGroup = s.group;
      const cls = s.ok ? "ok" : s.soft ? "soft" : "bad";
      const mark = s.ok ? "✓" : s.soft ? "⚠" : "✗";
      return `${header}<button class="step ${cls}" data-i="${i}">
        <span class="mark">${mark}</span>
        <span class="desc">${esc(s.desc)}</span>
        <span class="ms">${s.elapsedMs}ms</span>
      </button>`;
    })
    .join("");

  const panels = result.steps
    .map((s, i) => {
      const detail = s.ok ? "" : `<pre class="detail">${esc(s.detail)}</pre>`;
      const cls = s.ok ? "ok" : s.soft ? "soft" : "bad";
      const label = s.ok ? "passed" : s.soft ? "failed (soft)" : "failed";
      return `<div class="panel" data-i="${i}" ${i === selected ? "" : "hidden"}>
        <h2>Step ${i + 1}: ${esc(s.desc)} <span class="${cls}">${label}</span></h2>
        ${detail}
        ${screenToHtml(s.screen)}
      </div>`;
    })
    .join("");

  const status = result.ok ? "PASS" : "FAIL";
  return `<!doctype html><html><head><meta charset="utf-8"><title>trace: ${esc(result.name)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px system-ui,sans-serif; background:#0d0e14; color:#c9cbd6; }
  header { padding:12px 16px; border-bottom:1px solid #24263a; display:flex; gap:12px; align-items:center; }
  header .status { font-weight:bold; padding:2px 8px; border-radius:4px; }
  header .PASS { background:#1f4d2e; color:#7ee2a8; }
  header .FAIL { background:#5a1f24; color:#ff9aa2; }
  .layout { display:flex; height:calc(100vh - 50px); }
  .steps { width:340px; overflow:auto; border-right:1px solid #24263a; }
  .step { display:flex; gap:8px; width:100%; text-align:left; border:0; border-bottom:1px solid #1a1b28;
          background:none; color:inherit; padding:8px 12px; cursor:pointer; font:inherit; }
  .step:hover { background:#161826; }
  .step.active { background:#1e2136; }
  .step .mark { width:14px; } .step.ok .mark { color:#7ee2a8; } .step.bad .mark { color:#ff9aa2; }
  .step.soft .mark { color:#ffcf70; }
  .step .desc { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .step .ms { color:#6b6f85; }
  .group { padding:8px 12px 4px; font-size:11px; font-weight:700; letter-spacing:.06em;
           text-transform:uppercase; color:#8b8fa8; background:#111321; border-bottom:1px solid #1a1b28; }
  .view { flex:1; overflow:auto; padding:16px; }
  .view h2 { font-size:14px; font-weight:600; margin:0 0 10px; }
  .view h2 .ok { color:#7ee2a8; } .view h2 .bad { color:#ff9aa2; } .view h2 .soft { color:#ffcf70; }
  .detail { background:#161826; border:1px solid #2a2d44; border-radius:6px; padding:10px; white-space:pre-wrap;
            color:#ffb4ba; margin:0 0 12px; }
  .screen { display:inline-block; background:${DEFAULT_BG}; padding:10px; border-radius:6px;
            font-family:ui-monospace,"JetBrains Mono",Menlo,monospace; font-size:13px; line-height:1.25; white-space:pre; }
  .row { min-height:1.25em; }
  .noscreen { color:#6b6f85; }
</style></head><body>
<header><span class="status ${status}">${status}</span><strong>${esc(result.name)}</strong>
  <span>${result.steps.length} steps</span></header>
<div class="layout">
  <div class="steps">${buttons}</div>
  <div class="view">${panels}</div>
</div>
<script>
  const steps = [...document.querySelectorAll('.step')];
  const panels = [...document.querySelectorAll('.panel')];
  function show(i){
    steps.forEach(s => s.classList.toggle('active', +s.dataset.i === i));
    panels.forEach(p => { p.hidden = +p.dataset.i !== i; });
  }
  steps.forEach(s => s.addEventListener('click', () => show(+s.dataset.i)));
  show(${selected});
</script></body></html>`;
}
