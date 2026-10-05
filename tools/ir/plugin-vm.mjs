// The plugin's IR layer, exactly as tools/build-plugin.mjs bundles it, run in a Node vm: parts B and
// C test the text Figma will run, not a copy of it (docs/M1.md §5.4).
//
//   import { loadPluginIR } from "./ir/plugin-vm.mjs";
//   const IR = loadPluginIR({ figma, host });          // -> PXF_IR, host already set
//   const report = await IR.ops.build(IR.makeCtx(figma, task, { id: "t1" }), task);
//
//   loadPluginBundle({ figma, host, sources }) -> { PXF_IR, PXF_SCHEMA, PXF_TASK, PXF_PROPS, PXF_PATHGEOM, context }
//
// figma is the double (tools/double/index.mjs makeDouble().figma) or any stand-in. host is what
// figma-plugin/src/code.js gives PXF_IR.setHost: { images(), imageErrors(), progress(done, jobId),
// log?(m), phase?(name), measure?(ctx, node, rec) }; when omitted, an empty one whose progress calls
// are kept in host.progressed. sources is build-plugin's (irModules, irFiles), for tests that plant a
// file. The vm context has no setTimeout, setInterval or Node globals, as the IR layer may not use
// them; it has Date, Math, JSON, Promise and the rest of the language.
import { createContext, runInContext } from "node:vm";
import { irBundleSource } from "../build-plugin.mjs";

export function defaultHost() {
  const h = { progressed: [], logged: [] };
  h.images = () => ({});
  h.imageErrors = () => ({});
  h.progress = (done, id) => { h.progressed.push({ done, id }); };
  h.log = (m) => { h.logged.push(String(m)); };
  return h;
}

export function loadPluginBundle({ figma, host, sources } = {}) {
  const context = createContext({ figma, console });
  runInContext(irBundleSource(sources || {}), context, { filename: "plugin-ir-bundle.js" });
  context.PXF_IR.setHost(host || defaultHost());
  return { PXF_IR: context.PXF_IR, PXF_SCHEMA: context.PXF_SCHEMA, PXF_TASK: context.PXF_TASK, PXF_PROPS: context.PXF_PROPS,
    PXF_PATHGEOM: context.PXF_PATHGEOM, context };
}

export function loadPluginIR(opts) {
  return loadPluginBundle(opts).PXF_IR;
}
