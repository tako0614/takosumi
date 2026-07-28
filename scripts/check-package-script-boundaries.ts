import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findPackageScriptBoundaryViolations } from "./lib/package-script-boundaries";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const violations = await findPackageScriptBoundaryViolations(root);

if (violations.length > 0) {
  console.error(
    "Package script boundary check failed: package commands must be runnable from a standalone repository clone.",
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.manifestPath} script '${violation.scriptName}' references '${violation.reference}' outside the repository (${violation.resolvedPath})`,
    );
  }
  process.exit(1);
}

console.log(
  "Package script boundary check passed: no package command references a path outside the repository.",
);
