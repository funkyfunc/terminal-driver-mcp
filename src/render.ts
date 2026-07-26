/**
 * Render a structured cell snapshot to a PNG, so vision-capable models can see
 * the terminal's layout, colors, and box-drawing as pixels rather than
 * flattened text. Builds an SVG grid and rasterizes it with @resvg/resvg-js
 * (prebuilt native bindings — no Chromium). The monospace font is bundled
 * (JetBrains Mono, OFL) so rendering is deterministic across machines/CI.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import type { CellRun, CellSnapshot } from "./screen.js";

const FONT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "JetBrainsMono-Regular.ttf");
const FONT_FAMILY = "JetBrains Mono";

// Cell metrics at font size 17 (JetBrains Mono advance width ≈ 0.6em).
const FONT_SIZE = 17;
const CELL_W = Math.round(FONT_SIZE * 0.6);
const CELL_H = Math.round(FONT_SIZE * 1.3);
const PAD = 8;

// Default 16-color palette (xterm) for palette-indexed colors 0-15.
const ANSI_16 = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];
const DEFAULT_FG = "#e5e5e5";
const DEFAULT_BG = "#1a1b26";

function resolveColor(color: CellRun["fg"], fallback: string): string {
  if (color === undefined) return fallback;
  if (typeof color === "string") return color;
  const idx = color.palette;
  if (idx < 16) return ANSI_16[idx];
  if (idx < 232) {
    // 6x6x6 color cube
    const n = idx - 16;
    const to = (v: number) => (v === 0 ? 0 : v * 40 + 55);
    const r = to(Math.floor(n / 36) % 6);
    const g = to(Math.floor(n / 6) % 6);
    const b = to(n % 6);
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const gray = (idx - 232) * 10 + 8; // 24-step grayscale ramp
  return `#${gray.toString(16).padStart(2, "0").repeat(3)}`;
}

const escapeXml = (s: string): string =>
  s.replace(/[<>&"]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;"));

function buildSvg(snap: CellSnapshot): string {
  const width = snap.cols * CELL_W + PAD * 2;
  const height = snap.lines.length * CELL_H + PAD * 2;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${DEFAULT_BG}"/>`,
  ];

  snap.lines.forEach((line, rowIdx) => {
    const y = PAD + rowIdx * CELL_H;
    let col = 0;
    for (const run of line.runs) {
      const runCols = [...run.text].length;
      const x = PAD + col * CELL_W;
      // Inverse swaps fg/bg.
      const fg = resolveColor(run.inverse ? run.bg : run.fg, run.inverse ? DEFAULT_BG : DEFAULT_FG);
      const bg = resolveColor(run.inverse ? run.fg : run.bg, run.inverse ? DEFAULT_FG : DEFAULT_BG);
      if (run.bg !== undefined || run.inverse) {
        parts.push(`<rect x="${x}" y="${y}" width="${runCols * CELL_W}" height="${CELL_H}" fill="${bg}"/>`);
      }
      const weight = run.bold ? ' font-weight="bold"' : "";
      const style = run.italic ? ' font-style="italic"' : "";
      const deco = run.underline
        ? ' text-decoration="underline"'
        : run.strikethrough
          ? ' text-decoration="line-through"'
          : "";
      const opacity = run.dim ? ' fill-opacity="0.6"' : "";
      parts.push(
        `<text x="${x}" y="${y + FONT_SIZE}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${fg}"${weight}${style}${deco}${opacity} xml:space="preserve">${escapeXml(run.text)}</text>`,
      );
      col += runCols;
    }
  });

  // Cursor block (only when on the visible grid).
  if (snap.cursor.row >= 0 && snap.cursor.row < snap.lines.length) {
    const cx = PAD + snap.cursor.col * CELL_W;
    const cy = PAD + snap.cursor.row * CELL_H;
    parts.push(
      `<rect x="${cx}" y="${cy}" width="${CELL_W}" height="${CELL_H}" fill="${DEFAULT_FG}" fill-opacity="0.5"/>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

/** Render a cell snapshot to a PNG buffer. */
export function renderPng(snap: CellSnapshot): Buffer {
  const resvg = new Resvg(buildSvg(snap), {
    font: { fontFiles: [FONT_PATH], defaultFontFamily: FONT_FAMILY, loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
