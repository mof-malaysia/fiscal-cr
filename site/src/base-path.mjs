// A root-relative address ("/pasang") under the site's base ("/laman"), so
// "/pasang" becomes "/laman/pasang" and "/" becomes "/laman". The one place
// the base is applied: `url()` in site.ts and the Markdown links both use it.

/**
 * @param {string} base The site's base path, with or without a trailing slash.
 * @param {string} path A root-relative address; anything else is returned as it is.
 */
export function withBase(base, path) {
  const prefix = base.replace(/\/$/, "");
  if (!prefix || !path.startsWith("/") || path.startsWith("//")) return path;
  return path === "/" ? prefix : prefix + path;
}
