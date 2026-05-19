/**
 * Verify that `packages/contract/src/app-spec.ts`'s hand-written
 * `KIND_URI_BY_NAME` / `COMPONENT_KINDS` stay in sync with the JSON-LD
 * source of truth at `spec/contexts/kinds/v1/*.jsonld`.
 *
 * The contract package emits a hand-written TS map (rather than a
 * generated file) because:
 *   1. the contract package is the dependency root — generating into it
 *      would force `@takos/takosumi-contract` to depend on the spec
 *      tooling. Hand-written + drift check keeps the dependency direction
 *      one-way (spec → contract via human review + this script).
 *   2. each JSON-LD source's `@id` (canonical URI) and primary alias
 *      (= `aliases[0]`, the short name) are the only two values the
 *      contract map encodes; the larger generated shape lives in
 *      `packages/plugins/src/kinds/<basename>.generated.ts`.
 *
 * This script is invoked from `deno task spec:check-drift` so any change
 * to a JSON-LD `@id` / `aliases[0]` that is not mirrored into
 * `app-spec.ts` fails the drift check in CI.
 *
 * Exit codes:
 *   0 — in sync
 *   1 — drift detected
 *   2 — internal error (missing source file / parse failure)
 */
import { loadKindDocs } from "./spec-generate-ts.ts";
import { fromFileUrl } from "jsr:@std/path@^1.0.6";

const APP_SPEC_PATH = fromFileUrl(
  new URL("../packages/contract/src/app-spec.ts", import.meta.url),
);

if (import.meta.main) {
  Deno.exit(await main());
}

async function main(): Promise<number> {
  let appSpecSource: string;
  try {
    appSpecSource = await Deno.readTextFile(APP_SPEC_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[check-kind-uri-sync] cannot read app-spec.ts: ${msg}`);
    return 2;
  }

  let docs;
  try {
    docs = await loadKindDocs();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[check-kind-uri-sync] cannot load JSON-LD: ${msg}`);
    return 2;
  }

  if (docs.length === 0) {
    console.error("[check-kind-uri-sync] no JSON-LD kind sources found");
    return 2;
  }

  const expected: Array<{ shortName: string; uri: string }> = [];
  for (const { path, doc } of docs) {
    const id = doc["@id"];
    const alias = doc.aliases?.[0];
    if (typeof id !== "string" || id.length === 0) {
      console.error(`[check-kind-uri-sync] ${path}: missing @id`);
      return 2;
    }
    if (typeof alias !== "string" || alias.length === 0) {
      console.error(
        `[check-kind-uri-sync] ${path}: missing aliases[0] (short name)`,
      );
      return 2;
    }
    expected.push({ shortName: alias, uri: id });
  }

  const drifts: string[] = [];

  // Check each expected pair appears in the COMPONENT_KINDS array.
  const componentKindsBlock = extractBlock(
    appSpecSource,
    "COMPONENT_KINDS =",
  );
  if (componentKindsBlock === null) {
    drifts.push("missing COMPONENT_KINDS = [...] block in app-spec.ts");
  } else {
    for (const { shortName } of expected) {
      const needle = `"${shortName}"`;
      if (!componentKindsBlock.includes(needle)) {
        drifts.push(
          `COMPONENT_KINDS missing entry ${needle} (source: ${
            findJsonldFor(docs, shortName)
          })`,
        );
      }
    }
  }

  // Check the URI map literal contains exactly one binding per kind
  // matching the JSON-LD `@id`. The map source-of-truth uses a template
  // literal `${TAKOSUMI_KIND_URI_BASE}<suffix>` (where TAKOSUMI_KIND_URI_BASE
  // is verified separately below), or a plain string literal. We accept
  // either form so authors keep stylistic freedom.
  const mapBlock = extractBlock(appSpecSource, "KIND_URI_BY_NAME:");
  // Verify the URI base constant matches the prefix all 4 JSON-LD @ids share.
  const commonPrefix = sharedPrefix(expected.map((e) => e.uri));
  if (commonPrefix !== null) {
    const baseMatch = appSpecSource.match(
      /export const TAKOSUMI_KIND_URI_BASE\s*=\s*"([^"]+)"/,
    );
    if (baseMatch === null || baseMatch[1] !== commonPrefix) {
      drifts.push(
        `TAKOSUMI_KIND_URI_BASE in app-spec.ts does not match the shared ` +
          `prefix of all JSON-LD @ids (${commonPrefix})`,
      );
    }
  }

  if (mapBlock === null) {
    drifts.push("missing KIND_URI_BY_NAME block in app-spec.ts");
  } else {
    for (const { shortName, uri } of expected) {
      // Accept either bare key (`worker:`) or quoted key (`"object-store":`).
      const keyToken = /^[a-zA-Z_$][\w$]*$/.test(shortName)
        ? `${shortName}:`
        : `"${shortName}":`;
      const suffix = commonPrefix !== null && uri.startsWith(commonPrefix)
        ? uri.slice(commonPrefix.length)
        : uri;
      const candidates = [
        // Template-literal form using the base constant + bare suffix.
        `${keyToken} \`\${TAKOSUMI_KIND_URI_BASE}${suffix}\``,
        // Plain string literal form.
        `${keyToken} "${uri}"`,
        `${keyToken} '${uri}'`,
      ];
      if (!candidates.some((c) => mapBlock.includes(c))) {
        drifts.push(
          `KIND_URI_BY_NAME missing/incorrect binding for ${shortName} → ` +
            `${uri} (source: ${findJsonldFor(docs, shortName)})`,
        );
      }
    }
  }

  if (drifts.length > 0) {
    console.error(
      "[check-kind-uri-sync] DRIFT — app-spec.ts is out of sync with " +
        "spec/contexts/kinds/v1/*.jsonld:",
    );
    for (const d of drifts) {
      console.error(`  - ${d}`);
    }
    console.error(
      "\n  Update `packages/contract/src/app-spec.ts` (KIND_URI_BY_NAME / " +
        "COMPONENT_KINDS) to mirror the JSON-LD @id / aliases[0] values.",
    );
    return 1;
  }

  console.log(
    `[check-kind-uri-sync] OK — ${expected.length} kind(s) in app-spec.ts ` +
      `match JSON-LD sources`,
  );
  return 0;
}

/**
 * Extract the text between `<name> = [` / `<name>: ... = {` and the
 * matching closing bracket. Returns null if the symbol is not present.
 * Implementation is intentionally simple: it finds `<name>` token, then
 * scans forward until the first `[` or `{`, then to the matching
 * close-bracket counting nesting.
 */
function extractBlock(source: string, name: string): string | null {
  const idx = source.indexOf(name);
  if (idx === -1) return null;
  // Find the first `[` or `{` after the symbol.
  let i = idx + name.length;
  let open = "";
  let close = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === "[") {
      open = "[";
      close = "]";
      break;
    }
    if (ch === "{") {
      open = "{";
      close = "}";
      break;
    }
    i++;
  }
  if (open === "") return null;
  let depth = 0;
  let j = i;
  while (j < source.length) {
    const ch = source[j];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(i, j + 1);
    }
    j++;
  }
  return null;
}

function findJsonldFor(
  docs: Awaited<ReturnType<typeof loadKindDocs>>,
  shortName: string,
): string {
  const hit = docs.find((d) => d.doc.aliases?.[0] === shortName);
  return hit ? hit.path : "<unknown>";
}

/**
 * Longest common prefix of a non-empty list of strings. Returns null
 * if the input is empty or no character prefix is shared.
 */
function sharedPrefix(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  let prefix = values[0];
  for (let i = 1; i < values.length; i++) {
    while (prefix.length > 0 && !values[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix.length === 0) return null;
  }
  return prefix;
}
