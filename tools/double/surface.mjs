// The Figma plugin API surface the M1 plugin code may use: the frozen contract between parts B (the
// builder), C (verify and countLines) and E (the double that implements it). docs/M1.md §5.4.
//
// The headless double (tools/double/index.mjs) gives every node as a Proxy that throws on anything
// not listed here, so a builder that reaches outside the surface fails a test on this machine instead
// of in Figma. A part that needs more passes makeDouble({ allow }) in its tests and lists the
// addition in its pull request; part F folds those into this file (docs/M1.md §9, §11).
//
// SURFACE.figma.calls   functions on `figma`
// SURFACE.figma.read    plain properties of `figma`
// SURFACE.nodes[TYPE]   per Figma node type the M1 plugin creates or walks:
//   read     { prop: { layout: true|false } }; layout: true marks a getter that forces Figma to lay
//            out (LAYOUT_GETTERS); the double counts those per phase, and the builder may read
//            none of them while it creates (docs/M1.md §6 B)
//   write    [prop]
//   methods  [name]
//
// It covers builder4's API use (tools/builder4.js) plus what M1 adds: createVector,
// setVectorNetworkAsync, vectorPaths, fillGeometry, union / subtract / intersect / exclude,
// createComponent, createStar, createPolygon, createLine, the setRange* family, shared plugin data,
// loadFontAsync, listAvailableFontsAsync, createImage and getNodeByIdAsync. The Figma property names
// of tools/ir/props.mjs KNOWN_PROPS (everything but the IR's own props) are writable on the node type
// BUILT_TYPE maps each IR type to, so a prop the reader adds there is writable here without an edit.
import { KNOWN_PROPS } from "../ir/props.mjs";
import { IR_OWN_PROPS } from "../ir/schema.mjs";
import { BUILT_TYPE } from "../ir/task.mjs";

export const SURFACE_VERSION = 1;

export const LAYOUT_GETTERS = Object.freeze(["width", "height", "x", "y", "absoluteTransform", "absoluteBoundingBox",
  "absoluteRenderBounds"]);

const FIGMA_CALLS = ["createFrame", "createRectangle", "createEllipse", "createPolygon", "createStar", "createLine",
  "createVector", "createText", "createComponent", "createSection", "createPage", "createImage", "createNodeFromSvg",
  "union", "subtract", "intersect", "exclude", "loadFontAsync", "listAvailableFontsAsync", "getNodeByIdAsync",
  "loadAllPagesAsync", "setCurrentPageAsync", "base64Decode", "base64Encode"];
const FIGMA_READ = ["root", "currentPage", "mixed"];

const STAMPS = ["setPluginData", "getPluginData", "setSharedPluginData", "getSharedPluginData"];
const SCENE_READ = ["id", "type", "name", "parent", "removed", "visible", "locked", "opacity", "blendMode", "isMask",
  "maskType", "effects", "exportSettings", "relativeTransform", "rotation", "constraints", "layoutPositioning",
  "layoutAlign", "layoutGrow", "layoutSizingHorizontal", "layoutSizingVertical", "minWidth", "maxWidth", "minHeight",
  "maxHeight"];
const SCENE_WRITE = ["name", "visible", "locked", "opacity", "blendMode", "isMask", "maskType", "effects",
  "exportSettings", "relativeTransform", "x", "y", "constraints", "layoutPositioning", "layoutAlign", "layoutGrow",
  "layoutSizingHorizontal", "layoutSizingVertical", "minWidth", "maxWidth", "minHeight", "maxHeight"];
const SCENE_METHODS = ["remove", "resize", "resizeWithoutConstraints", "exportAsync"].concat(STAMPS);
const CONTAINER = { read: ["children"], methods: ["appendChild", "insertChild", "findAll", "findAllWithCriteria"] };
const PAINT = ["fills", "strokes", "strokeWeight", "strokeAlign", "strokeJoin", "strokeCap", "strokeMiterLimit",
  "dashPattern"];
const PAINT_READ_ONLY = ["fillGeometry", "strokeGeometry"];
const SIDES = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
const CORNERS = ["cornerRadius", "cornerSmoothing", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
const FRAME_LIKE = ["clipsContent", "layoutMode", "layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode",
  "primaryAxisAlignItems", "counterAxisAlignItems", "counterAxisAlignContent", "paddingLeft", "paddingRight",
  "paddingTop", "paddingBottom", "itemSpacing", "counterAxisSpacing", "itemReverseZIndex", "strokesIncludedInLayout",
  "layoutGrids", "overflowDirection"];
const TEXT = ["characters", "fontName", "fontSize", "letterSpacing", "lineHeight", "paragraphIndent", "paragraphSpacing",
  "listSpacing", "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textCase", "textDecoration",
  "textTruncation", "maxLines", "leadingTrim", "hangingPunctuation", "hangingList"];
const RANGE_SET = ["setRangeFontName", "setRangeFontSize", "setRangeFills", "setRangeTextCase", "setRangeTextDecoration",
  "setRangeLetterSpacing", "setRangeLineHeight", "setRangeHyperlink", "setRangeListOptions", "setRangeIndentation",
  "setRangeListSpacing", "setRangeParagraphIndent", "setRangeParagraphSpacing"];
const RANGE_GET = ["getRangeFontName", "getRangeFontSize", "getRangeLineHeight", "getRangeFills"];

function entry(read, write, methods) {
  const r = {};
  for (const p of read.concat(write)) r[p] = { layout: false };
  for (const p of LAYOUT_GETTERS) r[p] = { layout: true };
  delete r.x; delete r.y; r.x = { layout: true }; r.y = { layout: true };
  return { read: r, write: Array.from(new Set(write)), methods: Array.from(new Set(methods)) };
}

// The Figma names of the KNOWN_PROPS of every IR type built as `figmaType`.
function fromKnown(figmaType) {
  const out = [];
  for (const irType of Object.keys(BUILT_TYPE)) {
    if (BUILT_TYPE[irType] !== figmaType || !KNOWN_PROPS[irType]) continue;
    for (const p of Object.keys(KNOWN_PROPS[irType])) {
      if (IR_OWN_PROPS.indexOf(p) >= 0 && p !== "width" && p !== "height" && p !== "relativeTransform") continue;
      if (p === "width" || p === "height") continue; // resize(), never assigned
      out.push(p);
    }
  }
  return out;
}

function sceneType(figmaType, extraRead, extraWrite, extraMethods, container) {
  const write = SCENE_WRITE.concat(extraWrite, fromKnown(figmaType));
  const read = SCENE_READ.concat(extraRead, write.filter((p) => p !== "x" && p !== "y"));
  const methods = SCENE_METHODS.concat(extraMethods, container ? CONTAINER.methods : []);
  return entry(container ? read.concat(CONTAINER.read) : read, write, methods);
}

const NODES = {
  DOCUMENT: { read: { id: { layout: false }, type: { layout: false }, name: { layout: false }, children: { layout: false } },
    write: [], methods: STAMPS.concat(["findAll", "findAllWithCriteria"]) },
  PAGE: { read: { id: { layout: false }, type: { layout: false }, name: { layout: false }, parent: { layout: false },
    removed: { layout: false }, children: { layout: false }, backgrounds: { layout: false } },
  write: ["name", "backgrounds"], methods: STAMPS.concat(["appendChild", "insertChild", "findAll", "findAllWithCriteria", "loadAsync", "remove"]) },
  FRAME: sceneType("FRAME", PAINT_READ_ONLY, PAINT.concat(SIDES, CORNERS, FRAME_LIKE), [], true),
  COMPONENT: sceneType("COMPONENT", PAINT_READ_ONLY.concat(["key"]), PAINT.concat(SIDES, CORNERS, FRAME_LIKE), [], true),
  SECTION: sceneType("SECTION", [], ["fills"], [], true),
  RECTANGLE: sceneType("RECTANGLE", PAINT_READ_ONLY, PAINT.concat(SIDES, CORNERS), [], false),
  ELLIPSE: sceneType("ELLIPSE", PAINT_READ_ONLY, PAINT.concat(["arcData"]), [], false),
  POLYGON: sceneType("POLYGON", PAINT_READ_ONLY, PAINT.concat(["pointCount", "cornerRadius", "cornerSmoothing"]), [], false),
  STAR: sceneType("STAR", PAINT_READ_ONLY, PAINT.concat(["pointCount", "innerRadius", "cornerRadius", "cornerSmoothing"]), [], false),
  LINE: sceneType("LINE", PAINT_READ_ONLY, PAINT, [], false),
  VECTOR: sceneType("VECTOR", PAINT_READ_ONLY.concat(["vectorNetwork"]), PAINT.concat(["vectorPaths", "cornerRadius", "cornerSmoothing"]),
    ["setVectorNetworkAsync"], false),
  BOOLEAN_OPERATION: sceneType("BOOLEAN_OPERATION", PAINT_READ_ONLY, PAINT.concat(["booleanOperation"]), [], true),
  TEXT: sceneType("TEXT", PAINT_READ_ONLY, PAINT.concat(TEXT), RANGE_SET.concat(RANGE_GET), false),
};
// What vectors write is not a KNOWN_PROPS name: the network goes through setVectorNetworkAsync and
// geometry through vectorPaths, never by assignment.
for (const t of Object.keys(NODES)) {
  NODES[t].write = NODES[t].write.filter((p) => ["vectorNetwork", "fillGeometry", "strokeGeometry", "oracleFillGeometry", "booleanOperation"].indexOf(p) < 0 || (t === "BOOLEAN_OPERATION" && p === "booleanOperation"));
}

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}

export const SURFACE = deepFreeze({ figma: { calls: FIGMA_CALLS, read: FIGMA_READ }, nodes: NODES });

export function canRead(type, prop) { const e = SURFACE.nodes[type]; return !!(e && Object.prototype.hasOwnProperty.call(e.read, prop)); }
export function isLayoutRead(type, prop) { return canRead(type, prop) && SURFACE.nodes[type].read[prop].layout === true; }
export function canWrite(type, prop) { const e = SURFACE.nodes[type]; return !!(e && e.write.indexOf(prop) >= 0); }
export function canCall(type, method) { const e = SURFACE.nodes[type]; return !!(e && e.methods.indexOf(method) >= 0); }
