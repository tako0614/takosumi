// runner/lib/parsing.ts
//
// Request parsing for plan/apply/build/source + runner-profile/provider helpers.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { readFile } from "node:fs/promises";
import type {
  OpenTofuOperation,
  JsonRecord,
  OpenTofuModuleSource,
  GeneratedRoot,
  GeneratedRootModuleFile,
  BuildSpec,
  PrebuiltArtifactSpec,
} from "./types.ts";
import {
  isRecord,
  recordField,
  stringField,
  requiredStringField,
  stringArray,
  digestBytes,
} from "./util.ts";
import {
  assertGeneratedRootFileName,
  assertSafeRelativePath,
} from "./policy.ts";

export function parseOperation(request: unknown): OpenTofuOperation {
  const planRun = recordField(request, "planRun");
  const operation = planRun ? recordField(planRun, "operation") : undefined;
  return operation === "destroy" ||
    operation === "update" ||
    operation === "create"
    ? operation
    : "create";
}

export function parseSource(request: unknown): OpenTofuModuleSource {
  const planRun = recordField(request, "planRun");
  const source = recordField(planRun, "source");
  if (!isRecord(source)) throw new Error("planRun.source is required");
  const modulePath = stringField(source, "modulePath");
  const kind = stringField(source, "kind");
  if (kind === "git") {
    return {
      kind,
      url: requiredStringField(source, "url"),
      ...(stringField(source, "ref")
        ? { ref: stringField(source, "ref") }
        : {}),
      ...(stringField(source, "commit")
        ? { commit: stringField(source, "commit") }
        : {}),
      ...(modulePath ? { modulePath } : {}),
    };
  }
  if (kind === "prepared") {
    return {
      kind,
      url: requiredStringField(source, "url"),
      digest: requiredStringField(source, "digest"),
      ...(modulePath ? { modulePath } : {}),
    };
  }
  if (kind === "local") {
    return {
      kind,
      path: requiredStringField(source, "path"),
      ...(modulePath ? { modulePath } : {}),
    };
  }
  throw new Error("planRun.source.kind must be git, prepared, or local");
}

export function parseGeneratedRoot(
  request: unknown,
): GeneratedRoot | undefined {
  const generated = recordField(request, "generatedRoot");
  if (!isRecord(generated)) return undefined;
  const files = recordField(generated, "files");
  if (!isRecord(files)) {
    throw new Error("generatedRoot.files must be an object");
  }
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    assertGeneratedRootFileName(name);
    if (typeof content !== "string") {
      throw new Error(`generatedRoot.files[${name}] must be a string`);
    }
    out[name] = content;
  }
  if (Object.keys(out).length === 0) {
    throw new Error("generatedRoot.files must not be empty");
  }
  const moduleFilesValue = recordField(generated, "moduleFiles");
  const moduleFiles =
    moduleFilesValue === undefined
      ? undefined
      : parseGeneratedRootModuleFiles(moduleFilesValue);
  return {
    files: out,
    ...(moduleFiles ? { moduleFiles } : {}),
  };
}

export function parseGeneratedRootModuleFiles(
  value: unknown,
): readonly GeneratedRootModuleFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("generatedRoot.moduleFiles must be a non-empty array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`generatedRoot.moduleFiles[${index}] must be an object`);
    }
    const path = stringField(entry, "path");
    const text = stringField(entry, "text");
    if (!path) {
      throw new Error(
        `generatedRoot.moduleFiles[${index}].path must be a string`,
      );
    }
    if (text === undefined) {
      throw new Error(
        `generatedRoot.moduleFiles[${index}].text must be a string`,
      );
    }
    assertSafeRelativePath(path, `generatedRoot.moduleFiles[${index}].path`);
    return { path, text };
  });
}

export function parseBuild(request: unknown): BuildSpec | undefined {
  const build = recordField(request, "build");
  if (!isRecord(build)) return undefined;
  if (stringField(build, "runtime") !== "bun") {
    throw new Error("build.runtime must be 'bun'");
  }
  const commands = stringArray(recordField(build, "commands"));
  if (commands.length === 0) {
    throw new Error("build.commands must be a non-empty string array");
  }
  const artifactPath = requiredStringField(build, "artifactPath");
  assertSafeRelativePath(artifactPath, "build.artifactPath");
  return { runtime: "bun", commands, artifactPath };
}

export function parsePrebuiltArtifact(
  request: unknown,
): PrebuiltArtifactSpec | undefined {
  const artifact = recordField(request, "prebuiltArtifact");
  if (!isRecord(artifact)) return undefined;
  const path = requiredStringField(artifact, "path");
  assertSafeRelativePath(path, "prebuiltArtifact.path");
  return { path };
}

export function parseRunnerProfile(request: unknown): JsonRecord | undefined {
  return recordField(request, "runnerProfile") as JsonRecord | undefined;
}

export function parseRequiredProviders(request: unknown): readonly string[] {
  const planRun = recordField(request, "planRun");
  const providers = planRun
    ? recordField(planRun, "requiredProviders")
    : undefined;
  return stringArray(providers);
}

export function parseProviderInstallationPolicy(
  request: unknown,
): { readonly requireMirror: boolean } | undefined {
  const policy = recordField(request, "providerInstallationPolicy");
  return isRecord(policy) && recordField(policy, "requireMirror") === true
    ? { requireMirror: true }
    : undefined;
}

export function maxRunSecondsFromProfile(
  runnerProfile: JsonRecord | undefined,
): number | undefined {
  return positiveIntegerLimitFromProfile(runnerProfile, "maxRunSeconds");
}

export function positiveIntegerLimitFromProfile(
  runnerProfile: JsonRecord | undefined,
  key: string,
): number | undefined {
  const limits = recordField(runnerProfile, "resourceLimits");
  if (!limits) return undefined;
  const value = recordField(limits, key);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function parsePlanArtifact(request: unknown): { readonly digest: string } {
  const artifact = recordField(request, "planArtifact");
  if (!isRecord(artifact)) throw new Error("planArtifact is required");
  return { digest: requiredStringField(artifact, "digest") };
}

export async function verifyPlanArtifact(
  planPath: string,
  artifact: { readonly digest: string },
): Promise<void> {
  const bytes = await readFile(planPath);
  const digest = await digestBytes(bytes);
  if (digest !== artifact.digest) {
    throw new Error(`plan artifact digest mismatch: ${digest}`);
  }
}
