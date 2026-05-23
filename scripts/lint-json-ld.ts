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
 *    Must include `@context` / `@id` / `@type` / `name` / `aliases` /
 *    `publishes` / `listens`. `publishes` is an array of
 *    `{ namespacePath, material }` entries; `listens` is an object
 *    keyed by namespace path with `{ shape, envMap }` values.
 *
 * The lint is intentionally shallow: kernel does not perform JSON-LD
 * semantic expand, so we only assert the envelope and the namespace
 * pub/sub shape. Schema field checks (= `spec` / `outputs` /
 * `capabilities`) are not enforced here so operators can publish
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
      checkAliases(obj["aliases"], entry.path, issues);
      checkPublishes(obj["publishes"], entry.path, issues);
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

function checkAliases(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    issues.push({
      path,
      message: "missing `aliases` (declare short-name array, may be empty)",
    });
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "`aliases` must be an array of strings" });
    return;
  }
  for (const [index, alias] of value.entries()) {
    if (typeof alias !== "string" || alias.length === 0) {
      issues.push({
        path,
        message: `aliases[${index}] must be a non-empty string`,
      });
    }
  }
}

function checkPublishes(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    issues.push({
      path,
      message:
        "missing `publishes` (declare what this kind emits to the namespace registry)",
    });
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({
      path,
      message: "`publishes` must be an array of { namespacePath, material }",
    });
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({
        path,
        message: `publishes[${index}] must be an object`,
      });
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["namespacePath"] !== "string" || e["namespacePath"] === "") {
      issues.push({
        path,
        message: `publishes[${index}].namespacePath must be a non-empty string`,
      });
    }
    if (
      e["material"] === undefined ||
      e["material"] === null ||
      typeof e["material"] !== "object" ||
      Array.isArray(e["material"])
    ) {
      issues.push({
        path,
        message: `publishes[${index}].material must be an object`,
      });
    }
  }
}

function checkListens(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    issues.push({
      path,
      message:
        "missing `listens` (declare which namespace paths this kind can listen to, may be empty {})",
    });
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({
      path,
      message: "`listens` must be an object keyed by namespace path",
    });
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(obj)) {
    if (typeof key !== "string" || key.length === 0) {
      issues.push({
        path,
        message: "listens entry keys must be non-empty namespace paths",
      });
      continue;
    }
    if (
      descriptor === null ||
      typeof descriptor !== "object" ||
      Array.isArray(descriptor)
    ) {
      issues.push({
        path,
        message: `listens[${key}] must be an object { shape, envMap }`,
      });
      continue;
    }
    const d = descriptor as Record<string, unknown>;
    if (typeof d["shape"] !== "string" || d["shape"] === "") {
      issues.push({
        path,
        message: `listens[${key}].shape must be a non-empty string`,
      });
    }
    if (
      d["envMap"] !== undefined && (
        d["envMap"] === null ||
        typeof d["envMap"] !== "object" ||
        Array.isArray(d["envMap"])
      )
    ) {
      issues.push({
        path,
        message: `listens[${key}].envMap must be an object when present`,
      });
    }
  }
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
