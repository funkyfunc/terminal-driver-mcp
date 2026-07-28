/**
 * SGR mouse sequence encoding (the modern extended protocol, DECSET 1006).
 *
 * Format: ESC [ < Cb ; Cx ; Cy (M=press, m=release), where Cx/Cy are
 * 1-based columns/rows. Button codes: 0=left, 1=middle, 2=right; add 32 for
 * a motion (drag) event; 64/65 are wheel up/down (press-only, no release).
 */
export type MouseButton = "left" | "middle" | "right";
export type WheelDirection = "wheel_up" | "wheel_down";

const BUTTON_CODE: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };
const WHEEL_CODE: Record<WheelDirection, number> = { wheel_up: 64, wheel_down: 65 };
const MOTION = 32;

// Agent row/col are 0-based (matching session_read); SGR is 1-based.
function press(button: number, row: number, col: number): string {
  return `\x1b[<${button};${col + 1};${row + 1}M`;
}
function release(button: number, row: number, col: number): string {
  return `\x1b[<${button};${col + 1};${row + 1}m`;
}

/** A click (optionally multi-click): press+release pairs at one cell. */
export function encodeClick(button: MouseButton, row: number, col: number, count = 1): string {
  const code = BUTTON_CODE[button];
  let out = "";
  for (let i = 0; i < count; i++) out += press(code, row, col) + release(code, row, col);
  return out;
}

/** Wheel scrolling at a cell: one press-only event per tick (wheel has no release). */
export function encodeWheel(direction: WheelDirection, row: number, col: number, ticks = 1): string {
  const code = WHEEL_CODE[direction];
  let out = "";
  for (let i = 0; i < ticks; i++) out += press(code, row, col);
  return out;
}

/** A drag: press at the start, a motion event at the end, release at the end. */
export function encodeDrag(
  button: MouseButton,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
): string {
  const code = BUTTON_CODE[button];
  return press(code, fromRow, fromCol) + press(code + MOTION, toRow, toCol) + release(code, toRow, toCol);
}
