/**
 * Lint `spec/contexts/**\/*.jsonld` files.
 *
 * Two file shapes are accepted:
 *
 * 1. **Vocabulary root** (= e.g. `spec/contexts/v1.jsonld`). Single
 *    top-level key `@context` whose value is a JSON-LD context object.
 *    `@id` / `@type` / `name` are NOT required.
 * 2. **Kind document** (= e.g. `spec/contexts/kinds/v1/<name>.jsonld`).
 *    Must include `@context` / `@id` / `@type` / `name`.
 *
 * The lint is intentionally shallow: kernel does not perform JSON-LD
 * semantic expand, so we only assert the envelope. Schema field checks
 * (= `spec` / `outputs` / `capabilities`) are intentionally not enforced
 * here so operators can publish narrower kind variants if they wish.
 */
import { walk } from "jsr:@std/fs@^1.0.5/walk";
import { fromFileUrl } from "jsr:@std/path@^1.0.6";

interface LintIssue {
  readonly path: string;
  readonly message: string;
}

const ROOT = fromFileUrl(new URL("../spec/contexts", import.meta.url));

async function main(): Promise<void> {
  const issues: LintIssue[] = [];
  let fileCount = 0;
  try {
    const stat = await Deno.stat(ROOT);
    if (!stat.isDirectory) {
      console.error(`[lint:json-ld] not a directory: ${ROOT}`);
      Deno.exit(2);
    }
  } catch (_err) {
    console.error(`[lint:json-ld] missing directory: ${ROOT}`);
    Deno.exit(2);
  }

  for await (
    const entry of walk(ROOT, { includeDirs: false, exts: [".jsonld"] })
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
