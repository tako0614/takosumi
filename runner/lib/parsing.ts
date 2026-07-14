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
  OperatorModule,
  PlanScopeSelector,
  SourceBuildConfig,
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

export function parseRefreshOnly(request: unknown): boolean {
  const planRun = recordField(request, "planRun");
  return isRecord(planRun) && planRun.refreshOnly === true;
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
  if (kind === "operator_module") {
    return {
      kind,
      digest: requiredStringField(source, "digest"),
    };
  }
  throw new Error("planRun.source.kind must be git or operator_module");
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
  if (recordField(generated, "moduleFiles") !== undefined) {
    throw new Error(
      "generatedRoot.moduleFiles is retired; Capsule modules come from SourceSnapshot and Resource Shape modules use operatorModule",
    );
  }
  return { files: out };
}

export function parseOperatorModule(
  request: unknown,
): OperatorModule | undefined {
  const operatorModule = recordField(request, "operatorModule");
  if (operatorModule === undefined) return undefined;
  if (!isRecord(operatorModule)) {
    throw new Error("operatorModule must be an object");
  }
  const value = recordField(operatorModule, "files");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("operatorModule.files must be a non-empty array");
  }
  return {
    files: value.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new Error(`operatorModule.files[${index}] must be an object`);
      }
      const path = stringField(entry, "path");
      const text = stringField(entry, "text");
      if (!path) {
        throw new Error(`operatorModule.files[${index}].path must be a string`);
      }
      if (text === undefined) {
        throw new Error(`operatorModule.files[${index}].text must be a string`);
      }
      assertSafeRelativePath(path, `operatorModule.files[${index}].path`);
      return { path, text };
    }),
  };
}

export function parseVariables(request: unknown): JsonRecord {
  const variables = recordField(request, "variables");
  if (variables === undefined) return {};
  if (!isRecord(variables)) throw new Error("variables must be an object");
  try {
    return JSON.parse(JSON.stringify(variables)) as JsonRecord;
  } catch {
    throw new Error("variables must be JSON-serializable");
  }
}

export function parseSourceBuild(
  request: unknown,
): SourceBuildConfig | undefined {
  const value = recordField(request, "sourceBuild");
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("sourceBuild must be an object");
  }
  const commandsValue = recordField(value, "commands");
  const outputsValue = recordField(value, "outputs");
  if (
    !Array.isArray(commandsValue) ||
    commandsValue.length === 0 ||
    commandsValue.length > 8
  ) {
    throw new Error("sourceBuild.commands must contain 1-8 commands");
  }
  if (
    !Array.isArray(outputsValue) ||
    outputsValue.length === 0 ||
    outputsValue.length > 16
  ) {
    throw new Error("sourceBuild.outputs must contain 1-16 paths");
  }

  const commands = commandsValue.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`sourceBuild.commands[${index}] must be an object`);
    }
    const argv = recordField(entry, "argv");
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32) {
      throw new Error(
        `sourceBuild.commands[${index}].argv must contain 1-32 arguments`,
      );
    }
    if (
      argv.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length === 0 ||
          argument.length > 4096 ||
          argument.includes("\0"),
      )
    ) {
      throw new Error(
        `sourceBuild.commands[${index}].argv contains an invalid argument`,
      );
    }
    const workingDirectory = recordField(entry, "workingDirectory");
    if (workingDirectory !== undefined) {
      if (typeof workingDirectory !== "string") {
        throw new Error(
          `sourceBuild.commands[${index}].workingDirectory must be a string`,
        );
      }
      assertSafeRelativePath(
        workingDirectory,
        `sourceBuild.commands[${index}].workingDirectory`,
      );
    }
    return {
      argv: argv as string[],
      ...(typeof workingDirectory === "string" ? { workingDirectory } : {}),
    };
  });

  const outputs = outputsValue.map((output, index) => {
    if (typeof output !== "string") {
      throw new Error(`sourceBuild.outputs[${index}] must be a string`);
    }
    assertSafeRelativePath(output, `sourceBuild.outputs[${index}]`);
    if (/^\.[\\/]*$/u.test(output)) {
      throw new Error(
        `sourceBuild.outputs[${index}] must name a produced path`,
      );
    }
    return output;
  });
  return { commands, outputs };
}

export function assertNoLegacyArtifactDispatch(request: unknown): void {
  if (recordField(request, "build") !== undefined) {
    throw new Error(
      "build dispatch is retired; run the Git-hosted OpenTofu module and pass app release inputs as ordinary variables",
    );
  }
  if (recordField(request, "prebuiltArtifact") !== undefined) {
    throw new Error(
      "prebuiltArtifact dispatch is retired; run the Git-hosted OpenTofu module and pass app release inputs as ordinary variables",
    );
  }
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

export function parseOutputAllowlist(
  request: unknown,
):
  | Readonly<
      Record<string, { readonly from: string; readonly sensitive?: boolean }>
    >
  | undefined {
  const value = recordField(request, "outputAllowlist");
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("outputAllowlist must be an object");
  }
  const out: Record<
    string,
    { readonly from: string; readonly sensitive?: boolean }
  > = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(name) || !isRecord(entry)) {
      throw new Error(`outputAllowlist[${name}] is invalid`);
    }
    const from = stringField(entry, "from");
    if (!from || !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(from)) {
      throw new Error(`outputAllowlist[${name}].from is invalid`);
    }
    out[name] = {
      from,
      ...(recordField(entry, "sensitive") === true ? { sensitive: true } : {}),
    };
  }
  return out;
}

export function parseProviderInstallationPolicy(
  request: unknown,
): { readonly requireMirror: boolean } | undefined {
  const policy = recordField(request, "providerInstallationPolicy");
  return isRecord(policy) && recordField(policy, "requireMirror") === true
    ? { requireMirror: true }
    : undefined;
}

/** Parse the selector-only scope projection requested by policy. */
export function parsePlanScopeSelectors(
  request: unknown,
): readonly PlanScopeSelector[] {
  const value = recordField(request, "scopeSelectors");
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("scopeSelectors must be an array with at most 64 entries");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`scopeSelectors[${index}] must be an object`);
    }
    const resourceTypePattern = stringField(entry, "resourceTypePattern");
    if (
      !resourceTypePattern ||
      resourceTypePattern.length > 256 ||
      !/^[A-Za-z0-9_*?.:-]+$/u.test(resourceTypePattern)
    ) {
      throw new Error(
        `scopeSelectors[${index}].resourceTypePattern is invalid`,
      );
    }
    const rawDimensions = recordField(entry, "dimensions");
    if (!isRecord(rawDimensions) || Object.keys(rawDimensions).length > 32) {
      throw new Error(`scopeSelectors[${index}].dimensions is invalid`);
    }
    const dimensions: Record<string, string> = {};
    for (const [name, selector] of Object.entries(rawDimensions)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(name)) {
        throw new Error(`scopeSelectors[${index}].dimensions key is invalid`);
      }
      if (
        typeof selector !== "string" ||
        selector.length === 0 ||
        selector.length > 512 ||
        !selector.startsWith("/") ||
        /~(?:[^01]|$)/u.test(selector)
      ) {
        throw new Error(
          `scopeSelectors[${index}].dimensions.${name} must be an RFC 6901 JSON Pointer`,
        );
      }
      dimensions[name] = selector;
    }
    return { resourceTypePattern, dimensions };
  });
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

export function parsePlanArtifact(request: unknown): {
  readonly digest: string;
} {
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
