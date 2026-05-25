/**
 * Lint Takosumi JSON-LD files.
 *
 * Two file shapes are accepted:
 *
 * 1. **Vocabulary root** (= e.g. `spec/contexts/v1.jsonld`). Single
 *    top-level key `@context` whose value is a JSON-LD context object.
 *    `@id` / `@type` / `name` are NOT required.
 * 2. **Reference kind document** (= e.g.
 *    `packages/plugins/spec/kinds/v1/<name>.jsonld`).
 *    Must include `@context` / `@id` / `@type` / `name` /
 *    `referenceAliases` / `publications`. `publications` is an object keyed by local
 *    publication name with `{ contract, exampleMaterialMapping? }` values. A
 *    document can also include `listens` metadata for consumer-slot
 *    compatibility.
 *
 * The lint is intentionally shallow: kernel does not perform JSON-LD
 * semantic expand, so we only assert the envelope, publication metadata, and
 * projection-family metadata. Schema field checks (= `spec` / `outputs` /
 * `capabilityTerms`) are not enforced here so operators can publish
 * narrower kind variants if they wish.
 */
import { walk } from "jsr:@std/fs@^1.0.5/walk";
import { fromFileUrl } from "jsr:@std/path@^1.0.6";

interface LintIssue {
  readonly path: string;
  readonly message: string;
}

const ROOTS = [
  fromFileUrl(new URL("../spec/contexts", import.meta.url)),
  fromFileUrl(new URL("../packages/plugins/spec/kinds", import.meta.url)),
] as const;

async function main(): Promise<void> {
  const issues: LintIssue[] = [];
  let fileCount = 0;
  for (const root of ROOTS) {
    try {
      const stat = await Deno.stat(root);
      if (!stat.isDirectory) {
        console.error(`[lint:json-ld] not a directory: ${root}`);
        Deno.exit(2);
      }
    } catch (_err) {
      console.error(`[lint:json-ld] missing directory: ${root}`);
      Deno.exit(2);
    }

    for await (
      const entry of walk(root, { includeDirs: false, exts: [".jsonld"] })
    ) {
      fileCount++;
      const text = await Deno.readTextFile(entry.path);
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        issues.push({ path: entry.path, message: `invalid JSON: ${cause}` });
        continue;
      }
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        issues.push({
          path: entry.path,
          message: "top-level document must be an object",
        });
        continue;
      }
      const obj = doc as Record<string, unknown>;
      if (obj["@context"] === undefined) {
        issues.push({ path: entry.path, message: "missing @context" });
        continue;
      }
      if (isVocabularyRoot(obj)) continue;
      requireNonEmptyString(obj["@id"], "@id", entry.path, issues);
      requireNonEmptyString(obj["@type"], "@type", entry.path, issues);
      requireNonEmptyString(obj["name"], "name", entry.path, issues);
      checkReferenceAliases(obj["referenceAliases"], entry.path, issues);
      checkPublications(obj["publications"], entry.path, issues);
      checkNoLegacyAcceptedProjectionFamilies(
        obj["acceptedProjectionFamilies"],
        entry.path,
        issues,
      );
      checkListens(obj["listens"], entry.path, issues);
    }
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`[lint:json-ld] ${issue.path}: ${issue.message}`);
    }
    console.error(
      `[lint:json-ld] FAIL — ${issues.length} issue(s) across ${fileCount} file(s)`,
    );
    Deno.exit(1);
  }
  console.log(`[lint:json-ld] OK — ${fileCount} file(s) clean`);
}

function requireNonEmptyString(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({
      path,
      message: `${fieldName} must be a non-empty string`,
    });
  }
}

function checkReferenceAliases(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    issues.push({
      path,
      message:
        "missing `referenceAliases` (declare suggested short-name array, may be empty)",
    });
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({
      path,
      message: "`referenceAliases` must be an array of strings",
    });
    return;
  }
  for (const [index, alias] of value.entries()) {
    if (typeof alias !== "string" || alias.length === 0) {
      issues.push({
        path,
        message: `referenceAliases[${index}] must be a non-empty string`,
      });
    }
  }
}

function checkPublications(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    issues.push({
      path,
      message:
        "missing `publications` (declare local publications this kind can emit)",
    });
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({
      path,
      message:
        "`publications` must be an object keyed by local publication name",
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!isLocalName(key)) {
      issues.push({
        path,
        message: "publication keys must be local names",
      });
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({
        path,
        message: `publications[${key}] must be an object`,
      });
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["contract"] !== "string" || e["contract"] === "") {
      issues.push({
        path,
        message: `publications[${key}].contract must be a non-empty string`,
      });
    }
    if ("from" in e) {
      issues.push({
        path,
        message:
          `publications[${key}].from is obsolete; use exampleMaterialMapping metadata`,
      });
    }
    if ("material" in e) {
      issues.push({
        path,
        message:
          `publications[${key}].material is ambiguous; use exampleMaterialMapping`,
      });
    }
    if (
      e["exampleMaterialMapping"] !== undefined &&
      (e["exampleMaterialMapping"] === null ||
        typeof e["exampleMaterialMapping"] !== "object" ||
        Array.isArray(e["exampleMaterialMapping"]))
    ) {
      issues.push({
        path,
        message:
          `publications[${key}].exampleMaterialMapping must be an object when present`,
      });
    }
  }
}

function checkNoLegacyAcceptedProjectionFamilies(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    return;
  }
  issues.push({
    path,
    message:
      "`acceptedProjectionFamilies` is obsolete; use slot-local `listens` metadata",
  });
}

function checkListens(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({
      path,
      message: "`listens` must be an object keyed by listen slot name",
    });
  }
}

function isLocalName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * A vocabulary root document declares term mappings only. It has a
 * single top-level key (`@context`) and no `@id` / `@type` / `name`.
 */
function isVocabularyRoot(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === "@context";
}

if (import.meta.main) {
  await main();
}
