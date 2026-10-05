// Auto layout, the child side of it, constraints and clipping (docs/M1.md D14, IR.md §1).
//
// Frame side: stackMode → layoutMode (GRID has no Figma counterpart: NONE, SOURCE_FEATURE_UNSUPPORTED),
// stack sizing RESIZE_TO_FIT → AUTO and absent → FIXED, paddings, spacing, wrap, alignments, reverse
// draw → itemReverseZIndex, includeBorders → strokesIncludedInLayout, frameMaskDisabled → !clipsContent
// (absent: clip on), scrollDirection → overflowDirection, min and max size with NaN or FLT_MAX unset.
// SPACE_EVENLY becomes SPACE_BETWEEN with two or more visible flow children; with one it follows the
// spaceEvenlySingle setting.
//
// Child side, only under an auto-layout parent: autoLayoutAbsolutePos → layoutPositioning ABSOLUTE,
// child primary sizing RESIZE_TO_FIT → layoutGrow 1 (it appears only under a FIXED primary axis, and
// fills it), child counter sizing RESIZE_TO_FIT → layoutAlign STRETCH (the measured counter size
// equals the parent's inner size on 560 of 575 / 7 722 of 7 889). Constraints everywhere, FIXED_MIN
// and FIXED_MAX as MIN and MAX, absent MIN.
import * as E from "./enums.mjs";
import { r2, isFin } from "./util.mjs";

const FLT_BIG = 1e30;

export function isAutoLayout(cx, n) {
  const m = cx.en("PixsoNode", "stackMode")(n.stackMode);
  return m === "HORIZONTAL" || m === "VERTICAL";
}

export function frameLayoutProps(cx, n, put, children) {
  const mode = cx.en("PixsoNode", "stackMode")(n.stackMode);
  if (mode === "GRID") cx.feature("GRID");
  const lm = E.LAYOUT_MODE[mode] || "NONE";
  put("clipsContent", n.frameMaskDisabled !== true);
  put("layoutMode", lm);
  const sizing = (f) => E.AXIS_SIZING[cx.en("PixsoNode", f)(n[f])] || "FIXED";
  put("primaryAxisSizingMode", sizing("stackPrimarySizing"));
  put("counterAxisSizingMode", sizing("stackCounterSizing"));
  if (n.scrollDirection !== undefined) {
    const o = E.OVERFLOW[cx.en("PixsoNode", "scrollDirection")(n.scrollDirection)];
    if (o) put("overflowDirection", o);
  }
  if (lm === "NONE") return;
  const wrap = E.WRAP[cx.en("PixsoNode", "stackWrap")(n.stackWrap)] || "NO_WRAP";
  put("layoutWrap", wrap);
  const pa = cx.en("PixsoNode", "stackPrimaryAlignItems")(n.stackPrimaryAlignItems);
  if (pa === "SPACE_EVENLY") {
    const flow = children.filter((k) => !k.autoLayoutAbsolutePos && k.visible !== false);
    let v = "SPACE_BETWEEN";
    if (flow.length === 1) {
      v = cx.settings.spaceEvenlySingle === "center" ? "CENTER" : "SPACE_BETWEEN";
      cx.stats.spaceEvenly.single++;
    } else cx.stats.spaceEvenly.between++;
    put("primaryAxisAlignItems", v);
  } else if (E.PRIMARY_ALIGN[pa]) put("primaryAxisAlignItems", E.PRIMARY_ALIGN[pa]);
  const ca = cx.en("PixsoNode", "stackCounterAlignItems")(n.stackCounterAlignItems);
  if (E.COUNTER_ALIGN[ca]) put("counterAxisAlignItems", E.COUNTER_ALIGN[ca]);
  else if (ca !== undefined) cx.feature("counter alignment " + ca);
  const cc = E.ALIGN_CONTENT[cx.en("PixsoNode", "stackCounterAlignContent")(n.stackCounterAlignContent)];
  if (cc && wrap === "WRAP") put("counterAxisAlignContent", cc);
  const pad = (side, legacy) => r2(isFin(n[side]) ? n[side] : isFin(n[legacy]) ? n[legacy] : isFin(n.stackPadding) ? n.stackPadding : 0);
  put("paddingLeft", pad("stackPaddingLeft", "stackHorizontalPadding"));
  put("paddingRight", pad("stackPaddingRight", "stackHorizontalPadding"));
  put("paddingTop", pad("stackPaddingTop", "stackVerticalPadding"));
  put("paddingBottom", pad("stackPaddingBottom", "stackVerticalPadding"));
  if (isFin(n.stackSpacing)) put("itemSpacing", r2(n.stackSpacing));
  if (wrap === "WRAP" && isFin(n.stackCounterSpacing)) put("counterAxisSpacing", r2(n.stackCounterSpacing));
  if (n.autoLayoutItemReverseDraw) put("itemReverseZIndex", true);
  if (n.autoLayoutIncludeBorders) put("strokesIncludedInLayout", true);
}

export function childLayoutProps(cx, n, put, parentNode, own) {
  const h = E.CONSTRAINT[cx.en("PixsoNode", "horizontalConstraint")(n.horizontalConstraint)] || "MIN";
  const v = E.CONSTRAINT[cx.en("PixsoNode", "verticalConstraint")(n.verticalConstraint)] || "MIN";
  put("constraints", { horizontal: h, vertical: v });
  const inAL = !!parentNode && isAutoLayout(cx, parentNode);
  if (inAL) {
    if (n.autoLayoutAbsolutePos) put("layoutPositioning", "ABSOLUTE");
    else {
      if (cx.en("PixsoNode", "stackChildPrimarySizing")(n.stackChildPrimarySizing) === "RESIZE_TO_FIT") put("layoutGrow", 1);
      if (cx.en("PixsoNode", "stackChildCounterSizing")(n.stackChildCounterSizing) === "RESIZE_TO_FIT") put("layoutAlign", "STRETCH");
    }
  }
  // Figma takes min and max sizes on auto-layout frames and their flow children only.
  if (inAL || own) {
    const lim = (vec, k, test) => (vec && isFin(vec[k]) && test(vec[k]) ? r2(vec[k]) : undefined);
    const minW = lim(n.minSize, "x", (x) => x > 0), minH = lim(n.minSize, "y", (x) => x > 0);
    const maxW = lim(n.maxSize, "x", (x) => x >= 0 && x < FLT_BIG), maxH = lim(n.maxSize, "y", (x) => x >= 0 && x < FLT_BIG);
    if (minW !== undefined) put("minWidth", minW);
    if (maxW !== undefined) put("maxWidth", maxW);
    if (minH !== undefined) put("minHeight", minH);
    if (maxH !== undefined) put("maxHeight", maxH);
  }
}
