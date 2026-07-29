#!/usr/bin/env bun

import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const forbiddenPaths = [
  "provider",
  "scripts/provider-custody.mjs",
  "scripts/provider-custody-compatibility.mjs",
  "scripts/lib/provider-custody-compatibility.mjs",
  "scripts/lib/provider-proof-environment.mjs",
  "scripts/lib/provider-proof-requests.mjs",
  "scripts/lib/provider-proof-state.mjs",
] as const;
const forbiddenText = [
  "registry.opentofu.org/takosjp/takosumi",
  "registry.terraform.io/takosjp/takosumi",
  "takosumi/takosumi",
  "terraform-provider-takosumi",
  "takosumi_*",
  "Takosumi provider",
  "Takosumi-owned provider",
  "mixed Takosumi provider",
  "provider:custody",
  "provider/internal",
  "provider/release",
  "/opentofu/providers/",
] as const;
const scanRoots = [
  "AGENTS.md",
  "README.md",
  "README.en.md",
  "accounts",
  "app-docs",
  "cli",
  "contract",
  "core",
  "dashboard",
  "deploy",
  "docs",
  "opentofu-modules",
  "package.json",
  "runner",
  "scripts",
  "tests",
  "worker",
] as const;
const ignoredDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "vendor",
]);
const violations: string[] = [];

for (const path of forbiddenPaths) {
  try {
    await access(join(ROOT, path));
    violations.push(`forbidden first-party provider path exists: ${path}`);
  } catch {}
}

for (const root of scanRoots) {
  await scan(join(ROOT, root));
}

const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
for (const name of Object.keys(manifest.scripts ?? {})) {
  if (
    name === "test:provider" ||
    name.startsWith("provider:") ||
    name.startsWith("service-form:compat-")
  ) {
    violations.push(`forbidden package script exists: ${name}`);
  }
}

if (violations.length > 0) {
  console.error("First-party Takosumi provider removal check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  "First-party Takosumi provider removal check passed; generic external-provider execution remains available.",
);

async function scan(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    return;
  }
  if (metadata.isFile()) {
    if (!isTextFile(path)) return;
    const text = await readFile(path, "utf8");
    inspectText(path, text);
    return;
  }

  if (!metadata.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await scan(child);
      continue;
    }
    if (!entry.isFile() || !isTextFile(entry.name)) continue;
    inspectText(child, await readFile(child, "utf8"));
  }
}

function inspectText(path: string, text: string): void {
  const display = relative(ROOT, path).split(sep).join("/");
  if (display === "scripts/check-no-first-party-provider.ts") return;
  for (const token of forbiddenText) {
    if (text.includes(token)) {
      violations.push(`${display} contains retired provider token ${token}`);
    }
  }
}

function isTextFile(name: string): boolean {
  return /\.(?:cjs|css|go|hcl|html|js|json|jsonc|jsx|md|mjs|sh|tf|toml|ts|tsx|txt|yaml|yml)$/u.test(
    name,
  );
}
