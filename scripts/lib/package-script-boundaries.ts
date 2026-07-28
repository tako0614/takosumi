import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".output",
  ".vitepress",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export interface PackageScriptBoundaryViolation {
  readonly manifestPath: string;
  readonly scriptName: string;
  readonly reference: string;
  readonly resolvedPath: string;
}

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

export async function findPackageScriptBoundaryViolations(
  root: string,
): Promise<readonly PackageScriptBoundaryViolation[]> {
  const manifests = await findPackageManifests(root);
  const violations: PackageScriptBoundaryViolation[] = [];

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as PackageManifest;
    const manifestDirectory = dirname(manifestPath);
    for (const [scriptName, command] of Object.entries(
      manifest.scripts ?? {},
    )) {
      violations.push(
        ...findEscapingReferences({
          root,
          manifestDirectory,
          manifestPath,
          scriptName,
          command,
        }),
      );
    }
  }

  return violations.sort((a, b) =>
    `${a.manifestPath}:${a.scriptName}:${a.reference}`.localeCompare(
      `${b.manifestPath}:${b.scriptName}:${b.reference}`,
    ),
  );
}

export function findEscapingReferences(input: {
  readonly root: string;
  readonly manifestDirectory: string;
  readonly manifestPath: string;
  readonly scriptName: string;
  readonly command: string;
}): readonly PackageScriptBoundaryViolation[] {
  const root = resolve(input.root);
  let commandDirectory = resolve(input.manifestDirectory);
  const violations: PackageScriptBoundaryViolation[] = [];

  for (const segment of input.command.split(/\s*(?:&&|\|\||;)\s*/)) {
    const words = shellWords(segment);
    if (words.length === 0) continue;

    const commandWord = words[0]?.replace(/^\(+/, "");
    if (commandWord === "cd" && words[1]) {
      const target = cleanShellWord(words[1]);
      const resolvedTarget = resolve(commandDirectory, target);
      if (!isInside(root, resolvedTarget)) {
        violations.push(violation(input, root, target, resolvedTarget));
      }
      commandDirectory = resolvedTarget;
      continue;
    }

    for (const word of words) {
      const reference = cleanShellWord(word);
      if (!reference.startsWith("./") && !reference.startsWith("../")) {
        continue;
      }
      const resolvedPath = resolve(commandDirectory, reference);
      if (!isInside(root, resolvedPath)) {
        violations.push(violation(input, root, reference, resolvedPath));
      }
    }
  }

  return violations;
}

async function findPackageManifests(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  await walk(resolve(root), output);
  return output.sort();
}

async function walk(directory: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await walk(resolve(directory, entry.name), output);
      continue;
    }
    if (entry.isFile() && entry.name === "package.json") {
      output.push(resolve(directory, entry.name));
    }
  }
}

function shellWords(segment: string): readonly string[] {
  return segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) ?? [];
}

function cleanShellWord(word: string): string {
  return word
    .replace(/^["']|["']$/g, "")
    .replace(/^\(+/, "")
    .replace(/\)+$/, "");
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function violation(
  input: {
    readonly manifestPath: string;
    readonly scriptName: string;
  },
  root: string,
  reference: string,
  resolvedPath: string,
): PackageScriptBoundaryViolation {
  return {
    manifestPath: relative(root, input.manifestPath).split(sep).join("/"),
    scriptName: input.scriptName,
    reference,
    resolvedPath,
  };
}
