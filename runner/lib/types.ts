// runner/lib/types.ts
//
// Shared type and interface declarations for the OpenTofu runner.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.

export type OpenTofuRunAction =
  "plan" | "apply" | "destroy" | "compatibility_check" | "backup" | "release";
export type OpenTofuOperation = "create" | "update" | "destroy";
export type JsonRecord = Record<string, unknown>;
export type RunRequest = {
  readonly action?: unknown;
  readonly runId?: unknown;
  readonly request?: unknown;
};

export type OpenTofuModuleSource =
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref?: string;
      readonly commit?: string;
      readonly modulePath?: string;
    }
  | {
      /** Internal Resource Run identity; bytes arrive through operatorModule. */
      readonly kind: "operator_module";
      readonly digest: string;
    };

export interface RunWorkspace {
  readonly root: string;
  readonly sourceRoot: string;
  readonly moduleDir: string;
  readonly planPath: string;
  readonly restoredStatePath: string;
  readonly moduleInfoPath: string;
  // Generated-root workspace dirs. `generatedRootDir` is where tofu runs (it
  // holds the generated root module + child module); `artifactDir`
  // receives runner-produced backup/provider-snapshot metadata artifacts.
  readonly generatedRootDir: string;
  readonly childModuleDir: string;
  readonly artifactDir: string;
  // remote_state dependency states (spec §15): each producer state is written
  // read-only as <depsDir>/<name>.tfstate before init/plan/apply for the
  // consumer's `terraform_remote_state` data sources.
  readonly depsDir: string;
}

/** Generated root module HCL files (filename -> content). */
export interface GeneratedRoot {
  readonly files: Record<string, string>;
}

/** Operator-injected module used only by an explicit Resource Shape descriptor. */
export interface OperatorModule {
  readonly files: readonly OperatorModuleFile[];
}

export interface OperatorModuleFile {
  readonly path: string;
  readonly text: string;
}

export interface SourceBuildCommand {
  readonly argv: readonly string[];
  readonly workingDirectory?: string;
}

export interface SourceBuildConfig {
  readonly commands: readonly SourceBuildCommand[];
  readonly outputs: readonly string[];
}

export interface BackupSpec {
  readonly mode: "provider_snapshot" | "custom_command";
  readonly command?: readonly string[];
  readonly outputPath: string;
  /** Exact operator-installed adapter selected by BackupConfig. */
  readonly adapterId?: string;
}

export interface ReleaseCommandSpec {
  readonly id: string;
  readonly command: readonly string[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
}

export interface ReleaseSpec {
  readonly commands: readonly ReleaseCommandSpec[];
  readonly outputs?: JsonRecord;
  readonly activation?: ReleaseActivationSpec;
  readonly providerConfigurations: import("../../contract/provider-configurations.ts").ProviderConfigurationsEnvelope;
}

export interface ReleaseActivationSpec {
  readonly applyRunId?: string;
  readonly workspaceId?: string;
  readonly capsuleId?: string;
  readonly stateVersionId?: string;
}

export interface CommandContext {
  readonly env: Record<string, string>;
  readonly credentialManifest?: import("../../contract/credential-recipes.ts").RunCredentialRecipeManifest;
  readonly credentialFiles?: readonly ProviderCredentialFile[];
  readonly redactionValues?: readonly string[];
  readonly timeoutMs?: number;
  readonly sourceArchiveMaxBytes?: number;
  readonly sourceArchiveMaxDecompressedBytes?: number;
}

export interface ProviderCredentialFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
  readonly envName?: string;
}

/** Selector-only plan scope projection received from the control-plane policy. */
export interface PlanScopeSelector {
  readonly resourceTypePattern: string;
  readonly dimensions: Readonly<Record<string, string>>;
}

export interface PlanResponseOptions {
  readonly operation: OpenTofuOperation;
  /** Apply provider observations to state only; never mutate provider resources. */
  readonly refreshOnly?: boolean;
  readonly commandContext: CommandContext;
  readonly requiredProviders: readonly string[];
  /**
   * Explicit output projection requested by the control plane. The runner uses
   * only the `from` and `sensitive` fields to return fully-known, non-sensitive
   * planned outputs; arbitrary plan values never cross the runner boundary.
   */
  readonly outputAllowlist?: Readonly<
    Record<
      string,
      {
        readonly from: string;
        readonly sensitive?: boolean;
      }
    >
  >;
  readonly providerInstallationPolicy?: {
    readonly requireMirror: boolean;
  };
  readonly scopeSelectors?: readonly PlanScopeSelector[];
  readonly buildLog?: string;
  readonly variableFilePath?: string;
  readonly extra?: JsonRecord;
}
export interface SourceSyncSource {
  readonly url: string;
  readonly ref: string;
  readonly path: string;
}

export interface SourceCredentialFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
}

export interface SourceCredentials {
  readonly env: Record<string, string>;
  readonly files: readonly SourceCredentialFile[];
}

export interface SourceGitContext {
  readonly context: CommandContext;
}

export interface TarVerboseEntry {
  readonly type: string;
  readonly path: string;
  readonly size: number;
}

export interface PreparedProviderCredentialFiles {
  readonly context: CommandContext;
  readonly cleanup: () => Promise<void>;
}

/**
 * Result of walking a generated root for declared provider sources.
 * `complete` is false when the walk stopped early, so callers can tell a clean
 * tree apart from one the runner failed to read in full.
 */
export interface TerraformTreeProviderScan {
  readonly providers: readonly string[];
  readonly complete: boolean;
}

export interface RunnerPolicyBeforeInitOptions {
  readonly allowProviderFreeGeneratedRoot?: boolean;
  readonly requiredProviders?: readonly string[];
  /**
   * `false` when the generated-root provider scan hit its file/byte caps or
   * could not read a config file. A partial scan cannot be told apart from a
   * clean one, so a profile that carries a provider policy must refuse to init
   * rather than enforce the policy against an incomplete provider list.
   */
  readonly providerScanComplete?: boolean;
}

export interface StrictProviderMirrorAttestation {
  readonly providers: readonly string[];
  readonly cliConfigPath: string;
  readonly cliConfigDigest: string;
}

export interface ProviderMirrorInit {
  readonly commandContext: CommandContext;
  /** Absent in strict mirror mode: those runs install only from the mirror. */
  readonly providerCacheDir?: string;
  readonly sharedProviderCache: boolean;
  readonly attestation?: StrictProviderMirrorAttestation;
}
