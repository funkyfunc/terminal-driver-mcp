/**
 * Positional line diff of two terminal screens. A terminal screen is a fixed
 * grid, so a row-by-row comparison ("row 3 expected X, got Y") is clearer and
 * more useful than an LCS diff. Only differing rows are shown, capped.
 */
export function screenDiff(expected: string, actual: string, maxRows = 40): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  const n = Math.max(e.length, a.length);
  const out: string[] = [];
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const el = e[i] ?? "";
    const al = a[i] ?? "";
    if (el === al) continue;
    if (shown >= maxRows) {
      out.push(`… (${n - i} more differing row(s) omitted)`);
      break;
    }
    out.push(`row ${i}:`);
    out.push(`  - ${el}`);
    out.push(`  + ${al}`);
    shown++;
  }
  return out.length > 0 ? out.join("\n") : "(screens are identical)";
}
