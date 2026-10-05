// Exact bounds of Figma path strings, used on both sides of the vector check (docs/M1.md §6 C):
// the plugin's VERIFY bounds every built fill path with it, and the judge bounds the IR's oracle
// with it, so the two sides cannot disagree by method. Part C implements it; part P0 left this stub.
//
// Bundled into the plugin as PXF_PATHGEOM (tools/build-plugin.mjs): no import, no Node built-in,
// ES2015, `export const` / `export function` at the start of a line only.
//
// CONTRACT (frozen by P0):
//
//   pathBounds(data, matrix?) -> [{ x0, y0, x1, y1 }]
//     data    a Figma path string: M, L, Q, C and Z, every letter and number separated by white space
//             (schema.figmaPathError(data) === null)
//     matrix  optional 2x3 affine [[a, b, tx], [c, d, ty]], applied to every point before bounding;
//             absent means the identity
//     returns one box per subpath (each M starts one), in path order, from the exact extrema of every
//             segment: the end points, and for Q and C the curve's own extrema (the roots of its
//             derivative inside (0, 1)), never the control hull. An empty path gives [].
//     throws  an Error whose message starts "pathBounds:" on a string that is not a Figma path.
//
//   unionBounds(boxes) -> { x0, y0, x1, y1 } | null     the box around all of them; null for none
//
// Until part C replaces this file both throw, so nothing can silently use bounds that were never
// computed.

export const PATHGEOM_IMPLEMENTED = false;

export function pathBounds(data, matrix) {
  throw new Error("pathBounds: not in this build; part C implements tools/ir/pathgeom.mjs (docs/M1.md §6 C)");
}

export function unionBounds(boxes) {
  throw new Error("unionBounds: not in this build; part C implements tools/ir/pathgeom.mjs (docs/M1.md §6 C)");
}
