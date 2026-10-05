// What props each IR node type may carry, of which kind, and what an absent one means.
//
//   import * as props from "./ir/props.mjs";       // tools/ir/validate.mjs passes it to validateIR
//
// Data only: no import, no Node built-in, ES2015, `export const` at the start of a line, so that
// tools/build-plugin.mjs can bundle it into the plugin as PXF_PROPS (the builder writes DEFAULTS from
// it, and ctx.prop falls back to them). docs/M1.md §5.1 specifies it; part P0 wrote this first
// version from the Figma plugin API and today's payload (tools/pack4.mjs A and DROP), and part A
// owns it from then on: A runs D, K and M through it before merging, and a change any of them needs
// lands in A's pull request (docs/M1.md §9, §11 "KNOWN_PROPS and DEFAULTS may be wrong").
//
// KNOWN_PROPS[type][prop] is the prop's kind:
//   num    a finite number            int    an integer          bool   true or false
//   str    a string                   enum:A|B|…  one of the listed strings
//   value  an index into the IR's values (the prop is in schema.mjs INTERNED_PROPS)
//   style  an index into the IR's styles (the prop is in schema.mjs STYLE_REFS)
//   own    an IR-own prop whose rule is written out in schema.mjs (relativeTransform, strokeWeights,
//          cornerRadii, oracleSides, textRanges, inkBounds, componentPropertyReferences)
// A prop not listed for a type is an error, so a misspelt or misplaced prop cannot be silently
// ignored by the builder.
//
// DEFAULTS[prop] is the value an absent prop has. A reader may leave a prop out only when its value
// equals this; the builder writes it explicitly wherever KNOWN_PROPS says the prop applies, because
// Figma's own defaults are not the IR's. For a `value` prop the default is the value itself, not an
// index. A prop with no default and no value is not written at all (min and max sizes, maxLines,
// hyperlinks, styles).
//
// NEVER_OMIT props are written by the reader on every record whose type lists them, even at their
// default. Two kinds: props whose Figma default differs by node type (fills, strokes, strokeAlign,
// strokeWeight, clipsContent, blendMode, textAutoResize, layoutMode, and the two axis sizing modes,
// where a new Figma frame's default is not the source's absent value, FIXED), and props that have
// no IR default because no single value is right (a text's characters, fontName and fontSize; a
// boolean's operation; a star's or polygon's pointCount, a star's innerRadius). They have no
// DEFAULTS entry, and the validator refuses a record that lacks one. The builder writes each where
// Figma takes it (the axis sizing modes act only on an auto-layout frame).
//
// RANGE_FIELDS[field] is the kind of a text range field (a TEXT record's textRanges[].fields): the
// per-character properties Figma sets with setRange*.

const E = (vals) => "enum:" + vals.join("|");

const BLEND = E(["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN",
  "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE",
  "SATURATION", "COLOR", "LUMINOSITY"]);
const ALIGN = E(["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"]);
const SIZING = E(["FIXED", "HUG", "FILL"]);
const STROKE_CAP = E(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED",
  "TRIANGLE_FILLED", "CIRCLE_FILLED"]);
const TEXT_CASE = E(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]);
const TEXT_DECORATION = E(["NONE", "UNDERLINE", "STRIKETHROUGH"]);

const merge = function () {
  const o = {};
  for (let i = 0; i < arguments.length; i++) for (const k of Object.keys(arguments[i])) o[k] = arguments[i][k];
  return o;
};

// Every record: its box, and what lets it sit in its parent.
const BASE = { relativeTransform: "own", width: "num", height: "num", inkBounds: "own", visible: "bool", locked: "bool",
  componentPropertyReferences: "own" };
// What a child of an auto-layout frame (or a constrained child of any frame) says about itself.
const CHILD = { constraints: "value", layoutPositioning: E(["AUTO", "ABSOLUTE"]), layoutAlign: ALIGN, layoutGrow: "num",
  layoutSizingHorizontal: SIZING, layoutSizingVertical: SIZING, minWidth: "num", maxWidth: "num", minHeight: "num",
  maxHeight: "num" };
const BLEND_MIX = { opacity: "num", blendMode: BLEND, isMask: "bool", maskType: E(["ALPHA", "VECTOR", "LUMINANCE"]),
  effects: "value", effectStyle: "style", exportSettings: "value" };
const PAINT = { fills: "value", fillStyle: "style", strokes: "value", strokeStyle: "style", strokeWeight: "num",
  strokeAlign: E(["INSIDE", "OUTSIDE", "CENTER"]), strokeJoin: E(["MITER", "BEVEL", "ROUND"]), strokeCap: STROKE_CAP,
  strokeMiterLimit: "num", dashPattern: "value" };
const CORNER = { cornerRadius: "num", cornerSmoothing: "num" };
// Rectangle-like: independent sides and corners, and the side oracle (docs/M1.md D15).
const SIDES = { strokeWeights: "own", cornerRadii: "own", oracleSides: "own" };
const FRAME_LIKE = { clipsContent: "bool", layoutMode: E(["NONE", "HORIZONTAL", "VERTICAL"]), layoutWrap: E(["NO_WRAP", "WRAP"]),
  primaryAxisSizingMode: E(["FIXED", "AUTO"]), counterAxisSizingMode: E(["FIXED", "AUTO"]),
  primaryAxisAlignItems: E(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]), counterAxisAlignItems: E(["MIN", "MAX", "CENTER", "BASELINE"]),
  counterAxisAlignContent: E(["AUTO", "SPACE_BETWEEN"]), paddingLeft: "num", paddingRight: "num", paddingTop: "num",
  paddingBottom: "num", itemSpacing: "num", counterAxisSpacing: "num", itemReverseZIndex: "bool",
  strokesIncludedInLayout: "bool", layoutGrids: "value", gridStyle: "style",
  overflowDirection: E(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]) };
const TEXT_PROPS = { characters: "str", fontName: "value", fontSize: "num", letterSpacing: "value", lineHeight: "value",
  paragraphIndent: "num", paragraphSpacing: "num", listSpacing: "num",
  textAlignHorizontal: E(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]), textAlignVertical: E(["TOP", "CENTER", "BOTTOM"]),
  textAutoResize: E(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]), textCase: TEXT_CASE,
  textDecoration: TEXT_DECORATION, textTruncation: E(["DISABLED", "ENDING"]), maxLines: "int",
  leadingTrim: E(["NONE", "CAP_HEIGHT"]), hangingPunctuation: "bool", hangingList: "bool", textStyle: "style",
  textRanges: "own", lines: "int" };
const ORACLE = { oracleFillGeometry: "value" };

const FRAME = merge(BASE, CHILD, BLEND_MIX, PAINT, CORNER, SIDES, FRAME_LIKE);

export const KNOWN_PROPS = {
  FRAME: FRAME,
  // Built as a FRAME with fills [] and clipsContent false (docs/M1.md D4): a group carries no paints.
  GROUP: merge(BASE, CHILD, BLEND_MIX),
  // A Figma section has fills and no strokes, opacity or blend mode; Pixso's section strokes are
  // dropped by the reader with SOURCE_FEATURE_UNSUPPORTED (docs/M1.md D13).
  SECTION: merge(BASE, { fills: "value", fillStyle: "style" }),
  COMPONENT: FRAME,
  COMPONENT_SET: FRAME,
  // M1 builds an instance as a placeholder from its box and child-layout props (docs/M1.md D6); its
  // look is its master's and its overrides', which M2b carries.
  INSTANCE: merge(BASE, CHILD),
  RECTANGLE: merge(BASE, CHILD, BLEND_MIX, PAINT, CORNER, SIDES),
  ELLIPSE: merge(BASE, CHILD, BLEND_MIX, PAINT, { arcData: "value" }),
  POLYGON: merge(BASE, CHILD, BLEND_MIX, PAINT, CORNER, ORACLE, { pointCount: "int" }),
  STAR: merge(BASE, CHILD, BLEND_MIX, PAINT, CORNER, ORACLE, { pointCount: "int", innerRadius: "num" }),
  LINE: merge(BASE, CHILD, BLEND_MIX, PAINT, ORACLE),
  VECTOR: merge(BASE, CHILD, BLEND_MIX, PAINT, CORNER, ORACLE, { vectorNetwork: "value", fillGeometry: "value", strokeGeometry: "value" }),
  BOOLEAN_OPERATION: merge(BASE, CHILD, BLEND_MIX, PAINT, ORACLE,
    { booleanOperation: E(["UNION", "INTERSECT", "SUBTRACT", "EXCLUDE"]) }),
  TEXT: merge(BASE, CHILD, BLEND_MIX, PAINT, TEXT_PROPS),
  SLICE: merge(BASE, { constraints: "value", exportSettings: "value" }),
  // Never produced from Pixso; listed so a Figma tree read with the same list validates.
  SLOT: FRAME,
};

export const RANGE_FIELDS = { fontName: "value", fontSize: "num", fills: "value", fillStyle: "style", textStyle: "style",
  letterSpacing: "value", lineHeight: "value", textCase: TEXT_CASE, textDecoration: TEXT_DECORATION, hyperlink: "value",
  listOptions: "value", indentation: "int", listSpacing: "num", paragraphIndent: "num", paragraphSpacing: "num" };

export const NEVER_OMIT = ["fills", "strokes", "strokeAlign", "strokeWeight", "clipsContent", "blendMode", "textAutoResize",
  "layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode", "characters", "fontName", "fontSize", "booleanOperation",
  "pointCount", "innerRadius"];

export const DEFAULTS = {
  visible: true, locked: false, opacity: 1, isMask: false, maskType: "ALPHA", effects: [], exportSettings: [],
  constraints: { horizontal: "MIN", vertical: "MIN" },
  layoutPositioning: "AUTO", layoutAlign: "INHERIT", layoutGrow: 0,
  strokeJoin: "MITER", strokeCap: "NONE", strokeMiterLimit: 4, dashPattern: [],
  cornerRadius: 0, cornerSmoothing: 0,
  layoutWrap: "NO_WRAP", counterAxisAlignContent: "AUTO", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", paddingLeft: 0, paddingRight: 0,
  paddingTop: 0, paddingBottom: 0, itemSpacing: 0, counterAxisSpacing: 0, itemReverseZIndex: false,
  strokesIncludedInLayout: false, layoutGrids: [], overflowDirection: "NONE",
  arcData: { startingAngle: 0, endingAngle: 6.283185307179586, innerRadius: 0 },
  letterSpacing: { unit: "PIXELS", value: 0 }, lineHeight: { unit: "AUTO" }, paragraphIndent: 0, paragraphSpacing: 0,
  listSpacing: 0, textAlignHorizontal: "LEFT", textAlignVertical: "TOP", textCase: "ORIGINAL", textDecoration: "NONE",
  textTruncation: "DISABLED", leadingTrim: "NONE", hangingPunctuation: false, hangingList: false,
};
