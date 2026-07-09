// runner/lib/credentials.ts
//
// Credential env/file injection, shredding, and credential-env availability checks.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROVIDER_CREDENTIAL_ENV_RULES,
  isProviderEnvName,
  isReservedProviderEnvName,
  providerCredentialArgs,
  providerEnvRule,
  type ProviderCredentialEnvRule,
} from "../../contract/provider-env-rules.ts";
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
  providerMatches,
  shredCredentialDir,
} from "./util.ts";
import {
  assertSafeCredentialFileName,
  assertSafeCredentialFileMode,
} from "./policy.ts";
import { parseSourceCredentials } from "./source_sync.ts";
import {
  parseRequiredProviders,
  maxRunSecondsFromProfile,
  positiveIntegerLimitFromProfile,
} from "./parsing.ts";

export function commandContextFromRequest(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
): CommandContext {
  const env = baseCommandEnv();
  const requiredProviders = parseRequiredProviders(request);
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
  // §13 per-alias credential split uses `TF_VAR_…` env. Declared-env arbitrary
  // providers use their real provider env names (e.g. SNOWFLAKE_PASSWORD). Both
  // arrive ONLY via dispatched credentials (the Vault mints them per resolved
  // Connection — never from Bun.env, never from the runner profile env map). The
  // values are never logged and never echoed in the run response.
  for (const [name, value] of Object.entries(payloadCredentials)) {
    if (name.startsWith("TF_VAR_")) {
      env[name] = value;
      continue;
    }
    if (isAdmittedDeclaredProviderEnvName(name)) {
      env[name] = value;
    }
  }
  return {
    env,
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
 * `credentials` field. §13 per-alias tofu variables (`TF_VAR_...`) are admitted
 * for built-in root-only provider args. Declared-env provider variables are
 * admitted under their real env names after rejecting runner/runtime reserved
 * names. They are read only from the dispatched credential payload, never from
 * ambient process env, so built-in provider names such as CLOUDFLARE_API_TOKEN
 * can still be used by explicit generic-env ProviderConnections.
 */
export function credentialsFromRequest(
  request: unknown,
): Record<string, string> {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return {};
  const rawEnv = recordField(credentials, "env");
  if (isRecord(rawEnv)) {
    return credentialsFromRecord(rawEnv);
  }
  return credentialsFromRecord(credentials);
}

export function credentialsFromRecord(
  credentials: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(credentials)) {
    if (typeof value !== "string") continue;
    if (/^TF_VAR_[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      out[name] = value;
      continue;
    }
    if (isAdmittedDeclaredProviderEnvName(name)) {
      out[name] = value;
    }
  }
  return out;
}

export function providerCredentialFilesFromRequest(
  request: unknown,
): readonly ProviderCredentialFile[] {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return [];
  const files = recordField(credentials, "files");
  if (!Array.isArray(files)) return [];
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
    return {
      path,
      content,
      mode: Math.floor(mode),
      ...(envName ? { envName } : {}),
    };
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
  const credentialDir = join(workspace.root, ".provider-credentials");
  await mkdir(credentialDir, { recursive: true, mode: 0o700 });
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

/** Every credential env name any known provider may supply. */
export function allKnownCredentialEnvNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const rule of PROVIDER_CREDENTIAL_ENV_RULES) {
    for (const name of rule.envNames) names.add(name);
  }
  return names;
}

/**
 * Builds the env for credential-free source preparation and compatibility
 * checks. User-approved source-build commands run against a reviewed checkout
 * and MUST NOT see any provider credential.
 */
export function buildPhaseEnv(): Record<string, string> {
  const env = baseCommandEnv();
  const credentialNames = allKnownCredentialEnvNames();
  for (const name of Object.keys(env)) {
    if (credentialNames.has(name)) {
      // baseCommandEnv never includes these; this is defense-in-depth so a
      // future edit to BASE_COMMAND_ENV_NAMES can never silently leak a
      // credential into untrusted build commands.
      delete env[name];
    }
  }
  return env;
}

export function assertCommandEnvHasNoProviderCredentials(
  env: Readonly<Record<string, string>>,
): void {
  const credentialNames = allKnownCredentialEnvNames();
  for (const name of Object.keys(env)) {
    if (credentialNames.has(name)) {
      throw new Error(
        `command env unexpectedly carries provider credential env name ${name}`,
      );
    }
  }
}

export function assertCredentialEnvAvailable(
  requiredProviders: readonly string[],
  runnerProfile: JsonRecord,
  env: Readonly<Record<string, string>>,
): void {
  const requireCredentialRefs =
    recordField(runnerProfile, "requireCredentialRefs") === true;
  const credentialRefs = credentialRefsFromRunnerProfile(runnerProfile);
  for (const provider of requiredProviders) {
    const refs = credentialRefs.filter((ref) =>
      providerMatches(provider, ref.provider),
    );
    const requiredRefs = refs.filter(
      (ref) => ref.required || requireCredentialRefs,
    );
    if (requiredRefs.length === 0) continue;
    const envNames = credentialEnvNamesForProviderAndRefs(provider, refs);
    if (envNames.length === 0) {
      throw new Error(
        `no runner env mapping is configured for provider ${provider}`,
      );
    }
    const rule = providerEnvRule(provider);
    if (rule && rootOnlyCredentialEnvAvailable(provider, rule, env)) continue;
    const requiredGroups = envRequiredGroupsForRefs(rule, refs);
    const hasRequiredGroup =
      requiredGroups.length === 0
        ? envNames.some((envName) => env[envName])
        : requiredGroups.some((group) =>
            group.every((envName) => env[envName]),
          );
    if (!hasRequiredGroup) {
      throw new Error(
        `required credential env for provider ${provider} is not available in runner environment`,
      );
    }
  }
}

export function rootOnlyCredentialEnvAvailable(
  provider: string,
  rule: ProviderCredentialEnvRule,
  env: Readonly<Record<string, string>>,
): boolean {
  const requiredGroups =
    rule.requiredGroups.length > 0
      ? rule.requiredGroups
      : rule.envNames.map((name) => [name]);
  return requiredGroups.some((group) =>
    rootOnlyCredentialGroupAvailable(provider, group, env),
  );
}

export function rootOnlyCredentialGroupAvailable(
  provider: string,
  envNames: readonly string[],
  env: Readonly<Record<string, string>>,
): boolean {
  const argMap = providerCredentialArgs(provider);
  if (argMap.length === 0) {
    return envNames.every((name) => env[`TF_VAR_${name}`]);
  }
  const aliasSets = envNames.map((name) =>
    rootOnlyAliasesForProviderEnv(provider, name, env),
  );
  if (aliasSets.some((aliases) => aliases.size === 0)) return false;
  const [first, ...rest] = aliasSets;
  for (const alias of first ?? []) {
    if (rest.every((aliases) => aliases.has(alias))) return true;
  }
  return false;
}

export function rootOnlyAliasesForProviderEnv(
  provider: string,
  envName: string,
  env: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const localProvider = providerLocalName(provider);
  const aliases = new Set<string>();
  for (const { envName: mappedEnvName, arg } of providerCredentialArgs(
    provider,
  )) {
    if (mappedEnvName !== envName) continue;
    const prefix = `TF_VAR_${localProvider}_`;
    const suffix = `_${arg}`;
    for (const name of Object.keys(env)) {
      if (!name.startsWith(prefix)) continue;
      if (name === `TF_VAR_${localProvider}_${arg}`) {
        aliases.add("");
        continue;
      }
      if (!name.endsWith(suffix)) continue;
      const alias = name.slice(prefix.length, -suffix.length);
      if (/^[A-Za-z0-9_]+$/.test(alias)) aliases.add(alias);
    }
  }
  return aliases;
}

export function providerLocalName(provider: string): string {
  return (
    providerEnvRule(provider)?.shortName ??
    provider.split("/").pop() ??
    provider
  );
}

export function credentialRefsFromRunnerProfile(
  runnerProfile: JsonRecord | undefined,
): readonly {
  readonly provider: string;
  readonly ref: string;
  readonly required: boolean;
}[] {
  const refs = recordField(runnerProfile, "credentialRefs");
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((value) => {
    if (!isRecord(value)) return [];
    const provider = stringField(value, "provider");
    const ref = stringField(value, "ref");
    if (!provider || !ref) return [];
    return [
      { provider, ref, required: recordField(value, "required") === true },
    ];
  });
}

export function credentialEnvNamesForProviderAndRefs(
  provider: string,
  refs: readonly { readonly ref: string }[],
): readonly string[] {
  const names = new Set<string>(providerEnvRule(provider)?.envNames ?? []);
  for (const ref of refs) {
    for (const name of envNamesFromCredentialRef(ref.ref)) names.add(name);
  }
  return Array.from(names).sort();
}

export function envRequiredGroupsForRefs(
  rule: ProviderCredentialEnvRule | undefined,
  refs: readonly { readonly ref: string }[],
): readonly (readonly string[])[] {
  const groups: (readonly string[])[] = [...(rule?.requiredGroups ?? [])];
  for (const ref of refs) {
    const names = envNamesFromCredentialRef(ref.ref);
    if (names.length > 0) groups.push(names);
  }
  return groups;
}

export function envNamesFromCredentialRef(ref: string): readonly string[] {
  if (!ref.startsWith("env://")) return [];
  return ref
    .slice("env://".length)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Z_][A-Z0-9_]*$/.test(value));
}
