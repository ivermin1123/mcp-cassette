/**
 * Structural JSON diff producing JSON Pointer (RFC 6901) paths.
 *
 * Shared by `verify` (response drift classification) and replay's near-miss
 * diagnostics (naming exactly which argument diverged from the nearest
 * recording). Deliberately value-based and order-sensitive for arrays: a
 * cassette records one concrete payload, so positional comparison is the
 * honest one.
 */

export interface DiffEntry {
  /** JSON Pointer to the diverging value ("" = whole value). */
  path: string;
  recorded: unknown;
  live: unknown;
}

/** RFC 6901: "~" → "~0", "/" → "~1". */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function splitPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON Pointer (must start with "/"): ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Collect every path where the two values structurally differ. */
export function diffValues(recorded: unknown, live: unknown, path = ""): DiffEntry[] {
  if (Object.is(recorded, live)) return [];

  if (Array.isArray(recorded) && Array.isArray(live)) {
    const out: DiffEntry[] = [];
    const len = Math.max(recorded.length, live.length);
    for (let i = 0; i < len; i++) {
      if (i >= recorded.length || i >= live.length) {
        out.push({ path: `${path}/${i}`, recorded: recorded[i], live: live[i] });
      } else {
        out.push(...diffValues(recorded[i], live[i], `${path}/${i}`));
      }
    }
    return out;
  }

  if (isPlainObject(recorded) && isPlainObject(live)) {
    const out: DiffEntry[] = [];
    const keys = new Set([...Object.keys(recorded), ...Object.keys(live)]);
    for (const key of [...keys].sort()) {
      const child = `${path}/${escapePointerSegment(key)}`;
      if (!(key in recorded) || !(key in live)) {
        out.push({ path: child, recorded: recorded[key], live: live[key] });
      } else {
        out.push(...diffValues(recorded[key], live[key], child));
      }
    }
    return out;
  }

  // Primitive mismatch, or a container/primitive type mismatch: one entry here.
  return [{ path, recorded, live }];
}

/** Short single-line excerpt of a value for human-facing diff output. */
export function formatValue(value: unknown, maxLength = 60): string {
  const text = value === undefined ? "(absent)" : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
