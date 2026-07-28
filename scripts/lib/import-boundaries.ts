import { posix } from "node:path";
import ts from "typescript";

export interface ImportBoundarySource {
  readonly path: string;
  readonly content: string;
}

export interface ImportBoundaryViolation {
  readonly ruleId: "core-provider-import" | "lib-upper-layer-import";
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
  readonly message: string;
}

/**
 * Parse real TypeScript import syntax so comments and ordinary strings cannot
 * create false positives. Both runtime and type-only imports are checked:
 * Core owns provider ports, while leaf libraries stay below all implementation
 * and composition layers.
 */
export function findImportBoundaryViolations(
  sources: readonly ImportBoundarySource[],
): readonly ImportBoundaryViolation[] {
  const violations: ImportBoundaryViolation[] = [];
  for (const source of sources) {
    const checks = boundaryChecksFor(source.path);
    if (checks.length === 0) continue;
    const sourceFile = ts.createSourceFile(
      source.path,
      source.content,
      ts.ScriptTarget.Latest,
      true,
      source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      const specifier = importedModuleSpecifier(node);
      if (specifier !== undefined) {
        for (const check of checks) {
          if (!check.rejects(source.path, specifier)) continue;
          const location = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          violations.push({
            ruleId: check.ruleId,
            path: source.path,
            line: location.line + 1,
            specifier,
            message: check.message,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

interface ImportBoundaryCheck {
  readonly ruleId: ImportBoundaryViolation["ruleId"];
  readonly message: string;
  readonly rejects: (sourcePath: string, specifier: string) => boolean;
}

const CORE_PROVIDER_CHECK: ImportBoundaryCheck = {
  ruleId: "core-provider-import",
  message:
    "Core must depend on provider-neutral ports/contracts; provider implementations are injected by host composition",
  rejects: resolvesToProviderImplementation,
};

const LIB_UPPER_LAYER_CHECK: ImportBoundaryCheck = {
  ruleId: "lib-upper-layer-import",
  message:
    "Leaf libraries must not import Core, provider implementations, Accounts, Worker, or deploy composition",
  rejects: resolvesToUpperLayer,
};

function boundaryChecksFor(sourcePath: string): readonly ImportBoundaryCheck[] {
  if (sourcePath.startsWith("core/")) return [CORE_PROVIDER_CHECK];
  if (sourcePath.startsWith("lib/")) return [LIB_UPPER_LAYER_CHECK];
  return [];
}

function importedModuleSpecifier(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    const argument = node.arguments[0];
    return argument && ts.isStringLiteralLike(argument)
      ? argument.text
      : undefined;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  return undefined;
}

function resolvesToProviderImplementation(
  sourcePath: string,
  specifier: string,
): boolean {
  if (
    specifier === "@takosumi/providers" ||
    specifier.startsWith("@takosumi/providers/")
  ) {
    return true;
  }
  if (!specifier.startsWith(".")) return false;
  const resolved = posix.normalize(
    posix.join(posix.dirname(sourcePath), specifier),
  );
  return resolved === "providers" || resolved.startsWith("providers/");
}

const LIB_FORBIDDEN_ROOTS = [
  "core",
  "providers",
  "accounts",
  "worker",
  "deploy",
] as const;

const LIB_FORBIDDEN_PACKAGES = [
  "@takosumi/providers",
  "@takosumi/core",
  "@takosumi/worker",
  "@takosumi/deploy",
  "@takosjp/takosumi-providers",
  "@takosjp/takosumi-core",
  "@takosjp/takosumi-worker",
  "@takosjp/takosumi-deploy",
  "@takosjp/takosumi-accounts-contract",
  "@takosjp/takosumi-accounts-service",
  "takosumi-core",
  "takosumi-worker",
  "takosumi-deploy",
] as const;

function resolvesToUpperLayer(sourcePath: string, specifier: string): boolean {
  if (
    LIB_FORBIDDEN_PACKAGES.some(
      (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }

  const resolved = specifier.startsWith(".")
    ? posix.normalize(posix.join(posix.dirname(sourcePath), specifier))
    : posix.normalize(specifier);
  return LIB_FORBIDDEN_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(`${root}/`),
  );
}
