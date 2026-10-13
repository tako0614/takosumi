import { resolve } from "node:path";
import ts from "typescript";

export interface UnreferencedExportBudget {
  readonly file: string;
  readonly maximum: number;
}

export interface UnreferencedExportReport {
  readonly file: string;
  readonly unreferenced: readonly string[];
}

/**
 * A focused ratchet for the install helper module that previously accumulated
 * exported helpers which were tested but never used by production code. This
 * is intentionally not a repository-wide dead-code linter: the single budget
 * tracks that module and only counts actual TypeScript symbol references.
 */
export const UNREFERENCED_EXPORT_BUDGETS: readonly UnreferencedExportBudget[] = [
  { file: "dashboard/src/views/new/install-helpers.ts", maximum: 24 },
];

const EXCLUDED_DIRECTORIES = [
  "**/node_modules/**",
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/*_test.ts",
  "**/*_test.tsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/.worktrees/**",
];

export function discoverProductionTypeScriptFiles(root: string): string[] {
  return ts.sys
    .readDirectory(
      root,
      [".ts", ".tsx"],
      EXCLUDED_DIRECTORIES,
      ["**/*.ts", "**/*.tsx"],
    )
    .map((file) => resolve(file))
    .sort();
}

/**
 * Count target exports that have no production reference. TypeScript's
 * checker follows renamed imports and barrel exports to the original symbol.
 * Import and export syntax are excluded from references, so importing a module
 * for side effects or re-exporting a name does not claim that code is called.
 */
export function findUnreferencedExports(input: {
  readonly root: string;
  readonly target: string;
  readonly productionFiles?: readonly string[];
}): UnreferencedExportReport {
  const root = resolve(input.root);
  const target = resolve(root, input.target);
  const productionFiles = (input.productionFiles ??
    discoverProductionTypeScriptFiles(root)).map((file) => resolve(file));
  const program = ts.createProgram({
    rootNames: productionFiles,
    options: {
      allowImportingTsExtensions: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    },
  });
  const source = program.getSourceFile(target);
  if (!source) {
    throw new Error(`export ratchet target is not in the production source set: ${input.target}`);
  }
  const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(source);
  if (!moduleSymbol) {
    throw new Error(`export ratchet target has no module symbol: ${input.target}`);
  }

  const checker = program.getTypeChecker();
  const exports = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => ({ name: symbol.getName(), symbol: resolveAlias(checker, symbol) }))
    .filter(({ symbol }) => isFunctionConstOrClassExport(symbol));
  const referenced = new Set<ts.Symbol>();
  for (const fileName of productionFiles) {
    const current = program.getSourceFile(fileName);
    if (!current) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isProductionReference(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) referenced.add(resolveAlias(checker, symbol));
      }
      ts.forEachChild(node, visit);
    };
    visit(current);
  }

  return {
    file: input.target,
    unreferenced: exports
      .filter(({ symbol }) => !referenced.has(symbol))
      .map(({ name }) => name)
      .sort(),
  };
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  const visited = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !visited.has(current)) {
    visited.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function isFunctionConstOrClassExport(symbol: ts.Symbol): boolean {
  return (symbol.getDeclarations() ?? []).some((declaration) =>
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration)
  );
}

function isProductionReference(node: ts.Identifier): boolean {
  if (isDeclarationName(node)) return false;
  let current: ts.Node = node;
  while (current.parent) {
    current = current.parent;
    if (
      ts.isImportDeclaration(current) ||
      ts.isExportDeclaration(current) ||
      ts.isImportTypeNode(current)
    ) {
      return false;
    }
    if (ts.isSourceFile(current)) break;
  }
  return true;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isBindingElement(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isVariableDeclaration(parent)) &&
    parent.name === node
  );
}

function run(): void {
  const root = resolve(import.meta.dir, "..");
  let failed = false;
  for (const budget of UNREFERENCED_EXPORT_BUDGETS) {
    const report = findUnreferencedExports({ root, target: budget.file });
    const count = report.unreferenced.length;
    console.log(
      `Unreferenced exports: ${report.file}: ${count} (maximum ${budget.maximum})`,
    );
    if (count > budget.maximum) {
      failed = true;
      console.error(
        `Unreferenced-export budget exceeded for ${report.file}: ${report.unreferenced.join(", ")}`,
      );
    }
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) run();
