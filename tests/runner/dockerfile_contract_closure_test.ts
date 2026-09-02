import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../..");

/**
 * The runner image carries only the runtime import closure of the runner
 * server, copied file by file. There is no package.json, node_modules or
 * tsconfig.json at /app, so the closure must be reachable through relative
 * specifiers alone and every file in it must have its own COPY line. A missing
 * file only surfaces when the container starts, so this test walks the closure
 * transitively instead of trusting the direct imports.
 */
test("runner image copies the whole runtime import closure", async () => {
  const dockerfile = await readFile(resolve(ROOT, "runner/Dockerfile"), "utf8");
  const { files, bareSpecifiers } = await runtimeImportClosure([
    resolve(ROOT, "runner/entrypoint.ts"),
    ...(await typescriptFiles(resolve(ROOT, "runner/lib"))),
  ]);

  // Nothing resolves bare specifiers inside the image. Node builtins are the
  // only ones the Bun runtime answers on its own.
  expect([...bareSpecifiers].sort()).toEqual([]);

  const outsideRunner = [...files]
    .filter((path) => !path.startsWith("runner/"))
    .sort();
  expect(outsideRunner).toEqual([
    "contract/api-surface.ts",
    "contract/plan-scope.ts",
    "contract/provider-configurations.ts",
    "contract/provider-env-rules.ts",
    "contract/redaction.ts",
    "contract/reference/host-blocklist.ts",
    "contract/reference/ip-classification.ts",
    "contract/repository-manifest.ts",
    "contract/sources.ts",
    "lib/opentofu-configuration/src/mod.ts",
    "lib/rootgen/src/mod.ts",
  ]);
  for (const path of outsideRunner) {
    expect(dockerfile, path).toContain(`COPY ${path} ./${path}`);
  }

  // The runner's own tree ships wholesale; assert the two COPY lines that make
  // that true so the closure above stays meaningful.
  expect(dockerfile).toContain("COPY runner/entrypoint.ts ./runner/entrypoint.ts");
  expect(dockerfile).toContain("COPY runner/lib/ ./runner/lib/");
});

interface RuntimeImportClosure {
  readonly files: ReadonlySet<string>;
  readonly bareSpecifiers: ReadonlySet<string>;
}

async function runtimeImportClosure(
  entrypoints: readonly string[],
): Promise<RuntimeImportClosure> {
  const files = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const pending = [...entrypoints];

  while (pending.length > 0) {
    const path = pending.pop() as string;
    const repositoryPath = relative(ROOT, path);
    if (repositoryPath.startsWith("..")) {
      throw new Error(`runner import escaped the repository: ${path}`);
    }
    if (files.has(repositoryPath)) continue;
    files.add(repositoryPath);

    for (const specifier of runtimeModuleSpecifiers(
      path,
      await readFile(path, "utf8"),
    )) {
      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
        continue;
      }
      if (!specifier.startsWith(".")) {
        bareSpecifiers.add(specifier);
        continue;
      }
      pending.push(resolve(dirname(path), specifier));
    }
  }

  return { files, bareSpecifiers };
}

/**
 * Only imports the runtime actually evaluates. Type-only imports are erased
 * before the module is loaded, so they never need to be in the image.
 */
function runtimeModuleSpecifiers(
  path: string,
  content: string,
): readonly string[] {
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

async function typescriptFiles(directory: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await typescriptFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(path);
    }
  }
  return paths;
}
