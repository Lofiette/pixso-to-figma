// Enum names, and the Pixso → Figma translations of IR.md §1 (docs/M1.md §6 A).
//
// A .pix stores enums as numbers, and the numbers mean what the file's own schema says (read.mjs
// schemaInfo). The reader never compares a number: enumOf() resolves a field's value to its name
// through the field's declared enum type, so a schema that numbers its enums differently (the
// synthetic fixture can renumber every enum) gives the same IR. The tables below then map Pixso's
// names to Figma's.

// field(msgName, fieldName) -> (value) -> name | undefined. Cached per field.
export function enumReader(schema) {
  const { defs, byName } = schema;
  const cache = new Map();
  return function field(msg, name) {
    const key = msg + "." + name;
    let fn = cache.get(key);
    if (fn) return fn;
    const t = byName.get(msg);
    const f = t === undefined ? null : defs[t].fields.find((x) => x.name === name);
    let map = null;
    if (f && f.type >= 0 && defs[f.type] && defs[f.type].kind === 0) map = new Map(defs[f.type].fields.map((e) => [e.value, e.name]));
    fn = (v) => (v === undefined || v === null || !map ? undefined : map.get(v));
    cache.set(key, fn);
    return fn;
  };
}

// Pixso node type -> IR type. Types not listed are not carried (NODE_TYPE_UNSUPPORTED), except the
// ones the reader treats as structure (CANVAS, DIRECTORY, DOCUMENT) or as no record at all (VARIABLE,
// VARIABLE_SET; style definitions are recognised by their styleType, whatever their node type).
export const NODE_TYPE = {
  FRAME: "FRAME", GROUP: "GROUP", SECTION: "SECTION", SYMBOL: "COMPONENT", INSTANCE: "INSTANCE",
  RECTANGLE: "RECTANGLE", ROUNDED_RECTANGLE: "RECTANGLE", ELLIPSE: "ELLIPSE", REGULAR_POLYGON: "POLYGON",
  STAR: "STAR", LINE: "LINE", VECTOR: "VECTOR", BOOLEAN_OPERATION: "BOOLEAN_OPERATION", TEXT: "TEXT",
  SLICE: "SLICE", CONNECTLINE: "VECTOR",
};
export const STRUCTURE_TYPES = ["CANVAS", "DIRECTORY", "DOCUMENT"];
export const VARIABLE_TYPES = ["VARIABLE", "VARIABLE_SET"];

// Blend modes have the same names. A paint or an effect takes no PASS_THROUGH (that is a layer's).
export const BLEND = ["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN",
  "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION",
  "COLOR", "LUMINOSITY"];

export const BOOLEAN_OP = { UNION: "UNION", INTERSECT: "INTERSECT", SUBTRACT: "SUBTRACT", XOR: "EXCLUDE" };
export const WINDING = { NONZERO: "NONZERO", ODD: "EVENODD", INVERSE_NONZERO: "NONZERO", INVERSE_ODD: "EVENODD" };
export const STROKE_ALIGN = { CENTER: "CENTER", INSIDE: "INSIDE", OUTSIDE: "OUTSIDE" };
export const STROKE_JOIN = { MITER: "MITER", BEVEL: "BEVEL", ROUND: "ROUND" };
// Figma's caps; Pixso's SOLID_ROUND is Figma's CIRCLE_FILLED. HOLLOW_ROUND and VERTICAL_LINE have no
// Figma cap: NONE, SOURCE_FEATURE_UNSUPPORTED.
export const STROKE_CAP = { NONE: "NONE", ROUND: "ROUND", SQUARE: "SQUARE", ARROW_LINES: "ARROW_LINES",
  ARROW_EQUILATERAL: "ARROW_EQUILATERAL", TRIANGLE_FILLED: "TRIANGLE_FILLED", DIAMOND_FILLED: "DIAMOND_FILLED",
  SOLID_ROUND: "CIRCLE_FILLED" };
// Figma has MIN, CENTER, MAX, STRETCH and SCALE; Pixso's FIXED_* are its MIN and MAX.
export const CONSTRAINT = { MIN: "MIN", CENTER: "CENTER", MAX: "MAX", STRETCH: "STRETCH", SCALE: "SCALE",
  FIXED_MIN: "MIN", FIXED_MAX: "MAX" };
export const MASK_TYPE = { ALPHA: "ALPHA", OUTLINE: "VECTOR", LUMINANCE: "LUMINANCE" };
export const LAYOUT_MODE = { NONE: "NONE", HORIZONTAL: "HORIZONTAL", VERTICAL: "VERTICAL" };
export const AXIS_SIZING = { FIXED: "FIXED", RESIZE_TO_FIT: "AUTO" };
export const COUNTER_ALIGN = { MIN: "MIN", CENTER: "CENTER", MAX: "MAX" };
export const PRIMARY_ALIGN = { MIN: "MIN", CENTER: "CENTER", MAX: "MAX" };
export const ALIGN_CONTENT = { AUTO: "AUTO", SPACE_BETWEEN: "SPACE_BETWEEN" };
export const WRAP = { NO_WRAP: "NO_WRAP", WRAP: "WRAP" };
export const OVERFLOW = { NONE: "NONE", HORIZONTAL: "HORIZONTAL", VERTICAL: "VERTICAL", BOTH: "BOTH" };
export const TEXT_ALIGN_H = { LEFT: "LEFT", CENTER: "CENTER", RIGHT: "RIGHT", JUSTIFIED: "JUSTIFIED" };
export const TEXT_ALIGN_V = { TOP: "TOP", CENTER: "CENTER", BOTTOM: "BOTTOM" };
export const TEXT_AUTO_RESIZE = { NONE: "NONE", WIDTH_AND_HEIGHT: "WIDTH_AND_HEIGHT", HEIGHT: "HEIGHT" };
export const TEXT_CASE = { ORIGINAL: "ORIGINAL", UPPER: "UPPER", LOWER: "LOWER", TITLE: "TITLE", SMALL_CAPS: "SMALL_CAPS",
  SMALL_CAPS_FORCED: "SMALL_CAPS_FORCED" };
export const TEXT_DECORATION = { NONE: "NONE", UNDERLINE: "UNDERLINE", STRIKETHROUGH: "STRIKETHROUGH" };
export const TEXT_TRUNCATION = { DISABLED: "DISABLED", ENDING: "ENDING" };
export const LEADING_TRIM = { NONE: "NONE", CAP_HEIGHT: "CAP_HEIGHT" };
export const LIST_TYPE = { ORDERED_LIST: "ORDERED", UNORDERED_LIST: "UNORDERED" };
export const HANDLE_MIRRORING = { NONE: "NONE", ANGLE: "ANGLE", ANGLE_AND_LENGTH: "ANGLE_AND_LENGTH" };
// IMAGE and GIF are image paints in Figma; the gradients keep their names.
export const PAINT_TYPE = { SOLID: "SOLID", GRADIENT_LINEAR: "GRADIENT_LINEAR", GRADIENT_RADIAL: "GRADIENT_RADIAL",
  GRADIENT_ANGULAR: "GRADIENT_ANGULAR", GRADIENT_DIAMOND: "GRADIENT_DIAMOND", IMAGE: "IMAGE", GIF: "IMAGE" };
// Pixso's STRETCH is an image placed by its transform: Figma's CROP.
export const SCALE_MODE = { STRETCH: "CROP", FIT: "FIT", FILL: "FILL", TILE: "TILE" };
export const EFFECT_TYPE = { INNER_SHADOW: "INNER_SHADOW", DROP_SHADOW: "DROP_SHADOW", FOREGROUND_BLUR: "LAYER_BLUR",
  BACKGROUND_BLUR: "BACKGROUND_BLUR" };
export const EXPORT_FORMAT = { PNG: "PNG", JPEG: "JPG", SVG: "SVG", PDF: "PDF" };
export const EXPORT_CONSTRAINT = { CONTENT_SCALE: "SCALE", CONTENT_WIDTH: "WIDTH", CONTENT_HEIGHT: "HEIGHT" };
// The image filters Figma has. Pixso's vibrance and hue have no Figma field.
export const IMAGE_FILTERS = ["exposure", "contrast", "temperature", "tint", "highlights", "shadows"];
