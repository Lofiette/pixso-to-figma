// The one way Node code validates an IR or a task: schema.mjs, props.mjs and task.mjs stay
// import-free (the plugin bundles them), so the tables are passed in here, once, for every caller.
//
//   import { validate, validateTask } from "./ir/validate.mjs";
//   validate(ir, { maxErrors })                  -> { ok, errors: [{ path, message }] }   (docs/IR.md §14)
//   validateTask(task, { maxChars, maxErrors })  -> { ok, errors: [{ path, message }] }   (tools/ir/task.mjs)
//
// Neither throws on what it is given; both list at most maxErrors errors (200 by default).
import * as schema from "./schema.mjs";
import * as props from "./props.mjs";
import * as task from "./task.mjs";

export function validate(ir, opts) {
  return schema.validateIR(ir, { props, maxErrors: opts && opts.maxErrors });
}

export function validateTask(t, opts) {
  return task.validateTask(t, { schema, maxChars: opts && opts.maxChars, maxErrors: opts && opts.maxErrors });
}
