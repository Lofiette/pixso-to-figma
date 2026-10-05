// Nothing private is written inside the working tree (docs/M1.md D17, REWRITE.md §8). Every CLI
// that writes a file (pix-to-ir, pix-run, m1-accept, plugin-probe) passes the path through this first.
//
//   import { assertOutsideRepo } from "./ir/outside-repo.mjs";
//   const real = assertOutsideRepo(path);          // the path, resolved; throws when it is inside
//   assertOutsideRepo(path, { repo: someDir });    // tests: another directory plays the repository
//
// The check is on real paths, because the old one (path.relative on the given strings) let a write
// through a junction, a symlink or a drive letter in another case land in the repository:
// - the path is resolved against the current directory, and its nearest existing ancestor is
//   resolved with realpath (junctions and symlinks followed); the parts that do not exist yet are
//   appended to it unchanged;
// - the repository root is resolved the same way;
// - on Windows and macOS, whose file systems are case-insensitive by default, both are compared in
//   lower case.
// The path is refused when it is the repository root or anything beneath it. The error has
// code "INSIDE_REPO" and names the path and the repository.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The real path of p, for a p that may not exist yet.
export function realPathOf(p) {
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  let real = cur;
  try { real = realpathSync.native(cur); } catch (e) { /* a root that cannot be resolved stays as given */ }
  return rest.length ? join(real, ...rest) : real;
}

const fold = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);

export function isInside(p, dir) {
  const rel = relative(fold(realPathOf(dir)), fold(realPathOf(p)));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

export function assertOutsideRepo(p, opts) {
  if (typeof p !== "string" || !p) throw new TypeError("assertOutsideRepo: a path is required");
  const repo = (opts && opts.repo) || REPO_ROOT;
  const real = realPathOf(p);
  if (isInside(real, repo)) {
    const e = new Error("refused: " + p + " is inside the repository (" + realPathOf(repo) + "); private output goes to a folder outside it (docs/REWRITE.md §8), for example the per-user data folder or --data <dir>");
    e.code = "INSIDE_REPO";
    throw e;
  }
  return real;
}
