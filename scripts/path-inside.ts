import { isAbsolute, relative, resolve, sep } from "node:path";

/** True when `child` resolves to a strict descendant of `parent`. Blocks `..` traversal. */
export function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
