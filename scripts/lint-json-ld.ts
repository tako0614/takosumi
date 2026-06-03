/**
 * Lint Takosumi JSON-LD context files.
 *
 * The public JSON-LD surface is the vocabulary context served from /contexts/.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LintIssue {
  readonly path: string;
  readonly message: string;
}

const CONTEXT_ROOT = fileURLToPath(new URL("../spec/contexts", import.meta.url));

async function main(): Promise<void> {
  const issues: LintIssue[] = [];
  let fileCount = 0;

  try {
    const info = await stat(CONTEXT_ROOT);
    if (!info.isDirectory()) {
      console.error(`[lint:json-ld] not a directory: ${CONTEXT_ROOT}`);
      process.exit(2);
    }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    console.error(`[lint:json-ld] missing context directory: ${cause}`);
    process.exit(2);
  }

  for await (const path of walkJsonLdFiles(CONTEXT_ROOT)) {
    fileCount++;
    const text = await Bun.file(path).text();
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      issues.push({ path, message: `invalid JSON: ${cause}` });
      continue;
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      issues.push({ path, message: "top-level document must be an object" });
      continue;
    }
    const obj = doc as Record<string, unknown>;
    if (obj["@context"] === undefined) {
      issues.push({ path, message: "missing @context" });
      continue;
    }
    if (
      obj["@context"] === null ||
      typeof obj["@context"] !== "object" ||
      Array.isArray(obj["@context"])
    ) {
      issues.push({ path, message: "@context must be an object" });
      continue;
    }
    const context = obj["@context"] as Record<string, unknown>;
    const vocab = context["@vocab"];
    if (typeof vocab !== "string" || !vocab.startsWith("https://takosumi.com/")) {
      issues.push({
        path,
        message: '@context["@vocab"] must be a takosumi.com URL',
      });
    }
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`[lint:json-ld] ${issue.path}: ${issue.message}`);
    }
    console.error(
      `[lint:json-ld] FAIL - ${issues.length} issue(s) across ${fileCount} file(s)`,
    );
    process.exit(1);
  }

  console.log(`[lint:json-ld] OK - ${fileCount} context file(s) clean`);
}

async function* walkJsonLdFiles(root: string): AsyncIterableIterator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonLdFiles(path);
      continue;
    }
    if (entry.isFile() && path.endsWith(".jsonld")) {
      yield path;
    }
  }
}

if (import.meta.main) {
  await main();
}
