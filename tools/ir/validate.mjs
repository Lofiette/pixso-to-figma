// The one way Node code validates an IR: schema.mjs and props.mjs stay import-free (the plugin
// bundles them), so the tables are passed in here, once, for every caller.
//
//   import { validate } from "./ir/validate.mjs";
//   validate(ir, { maxErrors })      -> { ok, errors: [{ path, message }] }   (docs/IR.md §14)
//
// It never throws on what it is given, and lists at most maxErrors errors (200 by default).
import * as schema from "./schema.mjs";
import * as props from "./props.mjs";

export function validate(ir, opts) {
  return schema.validateIR(ir, { props, maxErrors: opts && opts.maxErrors });
}
