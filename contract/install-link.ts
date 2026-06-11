/**
 * External install link parser for the public `/install` Capsule entrypoint.
 *
 * External sites hand Takosumi a Git URL; both forms resolve to
 * `{ url, ref, path }` (a credential-less GitAddress seed):
 *
 *   /install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
 *   /install?git=https://git.example.com/takos/talk.git&ref=main&path=deploy
 *
 * The parser is PURE shape extraction: it does not enforce the Source URL
 * policy (https/ssh only, no embedded credentials, no file://) — callers must
 * run the canonical url-policy validation on the result before creating a
 * Source. It never throws; invalid input yields `undefined`.
 */

export interface InstallLinkTarget {
  readonly url: string;
  readonly ref: string;
  /** Capsule path within the repo. Defaults to `"."`. */
  readonly path: string;
}

const GIT_SOURCE_PREFIX = "git::";

/**
 * Parses the `source=git::<url>[//<path>][?ref=<ref>]` packed form. The `//`
 * path separator is searched AFTER the URL scheme's own `://` so
 * `git::https://host/repo.git//deploy` splits at `//deploy`.
 */
export function parseInstallSourceParam(
  raw: string,
): InstallLinkTarget | undefined {
  if (!raw.startsWith(GIT_SOURCE_PREFIX)) return undefined;
  let rest = raw.slice(GIT_SOURCE_PREFIX.length);
  if (rest.length === 0) return undefined;

  let ref = "";
  const queryIndex = rest.indexOf("?");
  if (queryIndex !== -1) {
    const query = new URLSearchParams(rest.slice(queryIndex + 1));
    ref = query.get("ref") ?? "";
    rest = rest.slice(0, queryIndex);
  }

  // Skip the scheme's own "//" (e.g. https://) when locating the path split.
  const schemeIndex = rest.indexOf("://");
  const searchFrom = schemeIndex === -1 ? 0 : schemeIndex + 3;
  const pathIndex = rest.indexOf("//", searchFrom);
  let url = rest;
  let path = ".";
  if (pathIndex !== -1) {
    url = rest.slice(0, pathIndex);
    const rawPath = rest.slice(pathIndex + 2);
    if (rawPath.length > 0) path = rawPath;
  }
  if (url.length === 0) return undefined;
  return { url, ref, path };
}

/**
 * Parses an /install link URL accepting both the packed `source=` form and the
 * simple `git=&ref=&path=` form. Returns `undefined` when neither
 * form is present or the packed form is malformed.
 */
export function parseInstallLink(link: URL): InstallLinkTarget | undefined {
  const source = link.searchParams.get("source");
  if (source !== null) {
    const target = parseInstallSourceParam(source);
    if (target === undefined) return undefined;
    if (target.ref.length > 0) return target;
    // Packed form without an embedded ?ref= — accept a top-level ref param.
    return { ...target, ref: link.searchParams.get("ref") ?? "" };
  }

  const git = link.searchParams.get("git");
  if (git === null || git.length === 0) return undefined;
  const ref = link.searchParams.get("ref") ?? "";
  const rawPath = link.searchParams.get("path") ?? "";
  return { url: git, ref, path: rawPath.length > 0 ? rawPath : "." };
}
