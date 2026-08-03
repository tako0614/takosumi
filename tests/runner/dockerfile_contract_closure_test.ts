import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../..");

test("runner image copies every runtime contract import", async () => {
  const dockerfile = await readFile(resolve(ROOT, "runner/Dockerfile"), "utf8");
  const sourceFiles = [
    resolve(ROOT, "runner/entrypoint.ts"),
    ...(await typescriptFiles(resolve(ROOT, "runner/lib"))),
  ];
  const runtimeContractPaths = new Set<string>();

  for (const path of sourceFiles) {
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        !statement.importClause?.isTypeOnly &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        addContractPath(
          runtimeContractPaths,
          path,
          statement.moduleSpecifier.text,
        );
      }
      if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        addContractPath(
          runtimeContractPaths,
          path,
          statement.moduleSpecifier.text,
        );
      }
    }
  }

  expect([...runtimeContractPaths].sort()).toEqual([
    "contract/plan-scope.ts",
    "contract/provider-configurations.ts",
    "contract/provider-env-rules.ts",
    "contract/reference/host-blocklist.ts",
    "contract/repository-manifest.ts",
  ]);
  for (const path of runtimeContractPaths) {
    expect(dockerfile).toContain(`COPY ${path} ./${path}`);
  }
});

function addContractPath(
  paths: Set<string>,
  importer: string,
  specifier: string,
): void {
  if (!specifier.startsWith("../../contract/")) return;
  const absolute = resolve(importer, "..", specifier);
  const path = relative(ROOT, absolute);
  if (!path.startsWith("contract/")) {
    throw new Error(`runner contract import escaped the repository: ${path}`);
  }
  paths.add(path);
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
