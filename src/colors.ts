/**
 * Resolve a cell color (default / palette-index / RGB hex) to a CSS/SVG hex
 * string. Shared by the PNG renderer and the HTML trace viewer.
 */
import type { CellColor } from "./screen.js";

// xterm default 16-color palette (indices 0-15).
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

export const DEFAULT_FG = "#e5e5e5";
export const DEFAULT_BG = "#1a1b26";

export function resolveColor(color: CellColor | undefined, fallback: string): string {
  if (color === undefined) return fallback;
  if (typeof color === "string") return color; // already #rrggbb
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
