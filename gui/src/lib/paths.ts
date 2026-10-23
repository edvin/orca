/** A path for people to read: `~/code/shop` rather than `/Users/alex/code/shop`.
 *  Display only; copy and open the full path. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}
