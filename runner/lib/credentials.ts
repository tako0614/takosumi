// runner/lib/credentials.ts
//
// Credential env/file injection, shredding, and credential-env availability checks.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isProviderEnvName,
  isReservedProviderEnvName,
} from "../../contract/provider-env-rules.ts";
import type { RunCredentialRecipeManifest } from "../../contract/credential-recipes.ts";
import type {
  JsonRecord,
  RunWorkspace,
  CommandContext,
  ProviderCredentialFile,
  SourceCredentials,
  PreparedProviderCredentialFiles,
} from "./types.ts";
import { BASE_COMMAND_ENV_NAMES } from "./constants.ts";
import {
  isRecord,
  recordField,
  stringField,
  shredCredentialDir,
} from "./util.ts";
import {
  assertSafeCredentialFileName,
  assertSafeCredentialFileMode,
} from "./policy.ts";
import { parseSourceCredentials } from "./source_sync.ts";
import {
  maxRunSecondsFromProfile,
  positiveIntegerLimitFromProfile,
} from "./parsing.ts";

export function commandContextFromRequest(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
): CommandContext {
  const env = baseCommandEnv();
  const credentialManifest = credentialManifestFromRequest(request);
  const payloadCredentials = credentialsFromRequest(request);
  const credentialFiles = providerCredentialFilesFromRequest(request);
  const redactionValues = redactionValuesFromRequestCredentials(request);
  const maxRunSeconds = maxRunSecondsFromProfile(runnerProfile);
  const maxSourceArchiveBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceArchiveBytes",
  );
  const maxSourceDecompressedBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceDecompressedBytes",
  );
  // Credential Recipes deliver provider credentials under their declared
  // process-env names (for example CLOUDFLARE_API_TOKEN or
  // SNOWFLAKE_PASSWORD). They arrive only via the dispatched credential bundle:
  // never from Bun.env and never from the runner profile env map.
  for (const [name, value] of Object.entries(payloadCredentials)) {
    if (isAdmittedDeclaredProviderEnvName(name)) {
      env[name] = value;
    }
  }
  return {
    env,
    ...(credentialManifest ? { credentialManifest } : {}),
    ...(credentialFiles.length > 0 ? { credentialFiles } : {}),
    ...(redactionValues.length > 0 ? { redactionValues } : {}),
    ...(maxRunSeconds ? { timeoutMs: maxRunSeconds * 1000 } : {}),
    ...(maxSourceArchiveBytes
      ? { sourceArchiveMaxBytes: maxSourceArchiveBytes }
      : {}),
    ...(maxSourceDecompressedBytes
      ? { sourceArchiveMaxDecompressedBytes: maxSourceDecompressedBytes }
      : {}),
  };
}

/**
 * Extracts the minted credential env map from the dispatch payload's
 * `credentials` field. Credential Recipe variables are admitted under their
 * declared env names after rejecting runner/runtime reserved names. They are
 * read only from the dispatched credential payload, never from ambient process
 * env. `TF_VAR_*` is intentionally reserved: credentials must not be smuggled
 * through generated-root input variables.
 */
export function credentialsFromRequest(
  request: unknown,
): Record<string, string> {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return {};
  const rawEnv = recordField(credentials, "env");
  const source = isRecord(rawEnv) ? rawEnv : credentials;
  const manifest = credentialManifestFromRequest(request);
  if (
    !manifest &&
    Object.keys(source).some((name) => typeof source[name] === "string")
  ) {
    throw new Error(
      "provider credentials require an explicit run credential manifest",
    );
  }
  const allowed = new Set(
    manifest?.bindings.flatMap((binding) =>
      binding.envNames.filter((name) => !binding.fileEnvNames.includes(name)),
    ) ?? [],
  );
  const out = credentialsFromRecord(source);
  for (const name of Object.keys(out)) {
    if (!allowed.has(name)) {
      throw new Error(
        `provider credential env name is not declared by the run recipe: ${name}`,
      );
    }
  }
  return out;
}

export function credentialsFromRecord(
  credentials: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(credentials)) {
    if (typeof value !== "string") continue;
    if (isAdmittedDeclaredProviderEnvName(name)) {
      out[name] = value;
    }
  }
  return out;
}

export function credentialManifestFromRequest(
  request: unknown,
): RunCredentialRecipeManifest | undefined {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return undefined;
  const value = recordField(credentials, "manifest");
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.bindings)) {
    throw new Error("run credential manifest is malformed");
  }
  const bindings = value.bindings.map((entry) => {
    if (!isRecord(entry))
      throw new Error("run credential manifest binding is malformed");
    const providerSource = stringField(entry, "providerSource");
    const connectionId = stringField(entry, "connectionId");
    const recipeId = stringField(entry, "recipeId");
    const authMode = stringField(entry, "authMode");
    const alias = stringField(entry, "alias");
    if (!providerSource || !connectionId || !recipeId || !authMode) {
      throw new Error("run credential manifest binding is malformed");
    }
    const envNames = safeManifestEnvNames(entry.envNames, "envNames");
    const fileEnvNames = safeManifestEnvNames(
      entry.fileEnvNames,
      "fileEnvNames",
    );
    if (!Array.isArray(entry.requiredEnvGroups)) {
      throw new Error("run credential manifest requiredEnvGroups is malformed");
    }
    const requiredEnvGroups = entry.requiredEnvGroups.map((group) =>
      safeManifestEnvNames(group, "requiredEnvGroups"),
    );
    return {
      providerSource,
      ...(alias ? { alias } : {}),
      connectionId,
      recipeId,
      authMode,
      envNames,
      fileEnvNames,
      requiredEnvGroups,
    };
  });
  const rawFiles = value.files;
  const files =
    rawFiles === undefined
      ? undefined
      : Array.isArray(rawFiles)
        ? rawFiles.map((entry) => {
            if (!isRecord(entry))
              throw new Error("run credential manifest file is malformed");
            const path = stringField(entry, "path");
            const envName = stringField(entry, "envName");
            const mode = entry.mode;
            if (!path || typeof mode !== "number") {
              throw new Error("run credential manifest file is malformed");
            }
            assertSafeCredentialFileName(path);
            assertSafeCredentialFileMode(mode);
            if (envName && !isAdmittedDeclaredProviderEnvName(envName)) {
              throw new Error(
                `run credential manifest file env name is unsafe: ${envName}`,
              );
            }
            return {
              path,
              mode: Math.floor(mode),
              ...(envName ? { envName } : {}),
            };
          })
        : (() => {
            throw new Error("run credential manifest files is malformed");
          })();
  return { bindings, ...(files ? { files } : {}) };
}

function safeManifestEnvNames(
  value: unknown,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`run credential manifest ${field} is malformed`);
  }
  return value.map((name) => {
    if (typeof name !== "string" || !isAdmittedDeclaredProviderEnvName(name)) {
      throw new Error(
        `run credential manifest ${field} contains an unsafe env name`,
      );
    }
    return name;
  });
}

function sameExplicitProviderSource(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const trimmed = value.trim();
    return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(trimmed)
      ? `registry.opentofu.org/${trimmed}`
      : trimmed;
  };
  return normalize(left) === normalize(right);
}

export function providerCredentialFilesFromRequest(
  request: unknown,
): readonly ProviderCredentialFile[] {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return [];
  const files = recordField(credentials, "files");
  if (!Array.isArray(files)) return [];
  const manifest = credentialManifestFromRequest(request);
  if (!manifest) {
    throw new Error(
      "provider credential files require an explicit run credential manifest",
    );
  }
  return files.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("provider credential file is malformed");
    }
    const path = stringField(entry, "path");
    const content = entry.content;
    const mode = entry.mode;
    const envName = stringField(entry, "envName");
    if (
      typeof path !== "string" ||
      typeof content !== "string" ||
      typeof mode !== "number"
    ) {
      throw new Error("provider credential file is malformed");
    }
    assertSafeCredentialFileName(path);
    assertSafeCredentialFileMode(mode);
    if (envName !== undefined && !isAdmittedDeclaredProviderEnvName(envName)) {
      throw new Error(
        `provider credential file env name is unsafe: ${envName}`,
      );
    }
    const normalized = {
      path,
      content,
      mode: Math.floor(mode),
      ...(envName ? { envName } : {}),
    };
    const declared = manifest.files?.some(
      (file) =>
        file.path === normalized.path &&
        file.mode === normalized.mode &&
        file.envName === normalized.envName,
    );
    if (!declared) {
      throw new Error(
        `provider credential file is not declared by the run recipe: ${path}`,
      );
    }
    return normalized;
  });
}

export function isAdmittedDeclaredProviderEnvName(name: string): boolean {
  return isProviderEnvName(name) && !isReservedProviderEnvName(name);
}

export function redactionValuesFromRequest(request: unknown): string[] {
  return [
    ...redactionValuesFromRequestCredentials(request),
    ...sourceCredentialRedactionValuesFromRequest(request),
  ];
}

export function redactionValuesFromRequestCredentials(
  request: unknown,
): string[] {
  return [
    ...Object.values(credentialsFromRequest(request)),
    ...providerCredentialFilesFromRequest(request).map((file) => file.content),
  ];
}

export function sourceCredentialRedactionValues(
  credentials: SourceCredentials,
): string[] {
  return [
    ...Object.values(credentials.env),
    ...credentials.files.map((file) => file.content),
  ];
}

export function sourceCredentialRedactionValuesFromRequest(
  request: unknown,
): string[] {
  try {
    return sourceCredentialRedactionValues(parseSourceCredentials(request));
  } catch {
    return [];
  }
}

export async function prepareProviderCredentialFiles(
  context: CommandContext,
  workspace: RunWorkspace,
): Promise<PreparedProviderCredentialFiles> {
  const files = context.credentialFiles ?? [];
  if (files.length === 0) {
    return { context, cleanup: async () => {} };
  }
  // A SIBLING of the run workspace with a random suffix, never a child of it:
  // the source-build phase runs user commands inside `workspace.sourceRoot`,
  // and `<workspace.root>/.provider-credentials` was one `../` away from them.
  const credentialDir = await mkdtemp(`${workspace.root}-credentials-`);
  await chmod(credentialDir, 0o700);
  const env: Record<string, string> = { ...context.env };
  for (const file of files) {
    assertSafeCredentialFileName(file.path);
    assertSafeCredentialFileMode(file.mode);
    const target = join(credentialDir, file.path);
    await writeFile(target, file.content, { mode: file.mode });
    await chmod(target, file.mode);
    if (file.envName) {
      if (!isAdmittedDeclaredProviderEnvName(file.envName)) {
        throw new Error(
          `provider credential file env name is unsafe: ${file.envName}`,
        );
      }
      env[file.envName] = target;
    }
  }
  return {
    context: { ...context, env },
    cleanup: async () => {
      await shredCredentialDir(credentialDir);
    },
  };
}

export function baseCommandEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    TF_INPUT: "0",
    TF_IN_AUTOMATION: "1",
  };
  for (const name of BASE_COMMAND_ENV_NAMES) {
    const value = Bun.env[name];
    if (typeof value === "string") env[name] = value;
  }
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return env;
}

/**
 * Builds the env for credential-free source preparation and compatibility
 * checks. User-approved source-build commands run against a reviewed checkout
 * and MUST NOT see any provider credential.
 */
export function buildPhaseEnv(): Record<string, string> {
  return baseCommandEnv();
}

export function assertCommandEnvHasNoProviderCredentials(
  env: Readonly<Record<string, string>>,
  additionalAllowedNames: readonly string[] = [],
): void {
  const allowedNames = new Set([
    ...Object.keys(baseCommandEnv()),
    ...additionalAllowedNames,
  ]);
  for (const name of Object.keys(env)) {
    if (!allowedNames.has(name)) {
      throw new Error(
        `build command env unexpectedly carries undeclared name ${name}`,
      );
    }
  }
}

export function assertCredentialEnvAvailable(
  requiredProviders: readonly string[],
  runnerProfile: JsonRecord,
  env: Readonly<Record<string, string>>,
  manifest?: RunCredentialRecipeManifest,
): void {
  const requireProviderBindings =
    recordField(runnerProfile, "requireProviderBindings") === true;
  for (const binding of manifest?.bindings ?? []) {
    const requiredGroups = binding.requiredEnvGroups;
    const envNames = binding.envNames;
    const hasRequiredGroup =
      requiredGroups.length === 0
        ? envNames.some((envName) => env[envName])
        : requiredGroups.some((group) =>
            group.every((envName) => env[envName]),
          );
    if (!hasRequiredGroup) {
      throw new Error(
        `required credential env for provider ${binding.providerSource} is not available in runner environment`,
      );
    }
  }
  if (requireProviderBindings) {
    for (const provider of requiredProviders) {
      if (
        !(manifest?.bindings ?? []).some((binding) =>
          sameExplicitProviderSource(provider, binding.providerSource),
        )
      ) {
        throw new Error(
          `explicit run credential recipe is required for provider ${provider}`,
        );
      }
    }
  }
}
