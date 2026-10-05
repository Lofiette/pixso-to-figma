// Booleans (docs/M1.md D5, §1.1).
//
// Class A: every visible operand is a filled shape (it has stored fill geometry, or is a RECTANGLE or
// an ELLIPSE, which Figma draws from their size) and none draws a visible stroke. For these the stored
// result equals the operation of the operands (297 / 297), so the boolean is built natively.
// Class B: an operand that draws a stroke, or one with no fill geometry. Pixso's stored result then
// follows the strokes' outline, which no operation of the fills reproduces (4 / 48), so under
// `--booleans auto` the reader writes one VECTOR from the boolean's stored fill geometry with the
// boolean's own paints and does not carry the operands (BOOLEAN_FLATTENED).
// `native` builds every boolean natively and counts the lost operand strokes; `flatten` flattens
// every one. A boolean with no operand is flattened when it has stored geometry and is not carried
// at all (GEOMETRY_INVALID) when it has none.
import { visiblePaint, weightOf } from "./strokes.mjs";

// "A", "B", "empty" (no operand, stored geometry), or "degenerate" (no operand, no geometry).
export function booleanClass(cx, n, kids, hasGeometry) {
  if (!kids.length) return hasGeometry ? "empty" : "degenerate";
  for (const k of kids) {
    if (k.visible === false) continue;
    const t = cx.typeName(k);
    if (visiblePaint(k.strokePaints) && weightOf(k) > 0) return "B";
    if (!(k.fillGeometry && k.fillGeometry.length) && t !== "RECTANGLE" && t !== "ELLIPSE" && t !== "ROUNDED_RECTANGLE") return "B";
  }
  return "A";
}

// Why a class B boolean is class B, for the note.
export function classBReason(cx, kids) {
  for (const k of kids) if (k.visible !== false && visiblePaint(k.strokePaints) && weightOf(k) > 0) return "operand strokes";
  return "an operand without fill geometry";
}

// Whether the boolean is written as one VECTOR under the setting.
export function flattens(setting, cls) {
  if (cls === "empty") return true;
  if (setting === "flatten") return true;
  if (setting === "native") return false;
  return cls === "B";
}
