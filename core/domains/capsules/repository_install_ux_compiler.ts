import type {
  CapsuleCompatibilityReport,
  CapsuleRootModuleVariableDeclaration,
} from "takosumi-contract/capsules";
import type {
  InstallConfigInstallExperience,
  InstallConfigVariablePresentation,
} from "takosumi-contract/install-configs";
import type {
  RepositoryInstallUxInput,
  RepositoryInstallUxInputSource,
  RepositoryInstallUxProjection,
  RepositoryManifestDocument,
} from "takosumi-contract/repository-manifest";
import type { JsonValue } from "takosumi-contract/types";

const SUPPORTED_SOURCE_KINDS = [
  "user",
  "capsule_name",
  "workspace_scoped_capsule_name",
  "module_default",
] as const;

const SUPPORTED_PROJECTION_KINDS = [
  "service_name",
  "public_endpoint",
  "initial_secret",
  "oidc_client",
  "artifact",
] as const;

const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240;
const PLAIN_ENV_VARIABLE = "env";

export type RepositoryInstallUxDiagnosticCode =
  | "repository_install_ux_document_invalid"
  | "repository_install_ux_module_missing"
  | "repository_install_ux_module_path_invalid"
  | "repository_install_ux_compatibility_report_mismatch"
  | "repository_install_ux_compatibility_report_unsupported"
  | "repository_install_ux_variable_metadata_unavailable"
  | "repository_install_ux_variable_missing"
  | "repository_install_ux_variable_type_mismatch"
  | "repository_install_ux_variable_default_mismatch"
  | "repository_install_ux_variable_value_missing"
  | "repository_install_ux_variable_value_type_mismatch"
  | "repository_install_ux_variable_value_unsupported"
  | "repository_install_ux_plain_env_unsupported"
  | "repository_install_ux_source_disallowed"
  | "repository_install_ux_projection_disallowed"
  | "repository_install_ux_projection_variable_invalid"
  | "repository_install_ux_oidc_scope_disallowed"
  | "repository_install_ux_feature_input_invalid"
  | "repository_install_ux_secret_materialization_required";

export interface RepositoryInstallUxDiagnostic {
  readonly code: RepositoryInstallUxDiagnosticCode;
  readonly message: string;
}

export interface RepositoryInstallUxCompilerPolicy {
  readonly allowedSourceKinds?: readonly RepositoryInstallUxInputSource["kind"][];
  readonly allowedProjectionKinds?: readonly RepositoryInstallUxProjection["kind"][];
  readonly allowedOidcScopes?: readonly string[];
}

export interface CompileRepositoryInstallUxInput {
  readonly document: RepositoryManifestDocument;
  readonly sourceSnapshotId: string;
  readonly modulePath: string;
  readonly compatibilityReport: CapsuleCompatibilityReport;
  readonly capsuleName: string;
  readonly workspaceId: string;
  readonly reviewedVariables?: Readonly<Record<string, JsonValue>>;
  /** Preview compilation may defer user answers but never type/policy checks. */
  readonly requireReviewedValues?: boolean;
  readonly policy?: RepositoryInstallUxCompilerPolicy;
}

export interface CompiledRepositoryInstallUx {
  readonly variablePresentation: readonly InstallConfigVariablePresentation[];
  readonly installExperience: InstallConfigInstallExperience;
  readonly variableMapping: Readonly<Record<string, JsonValue>>;
  /** User-owned names accepted from the reviewed request. */
  readonly userVariableNames: readonly string[];
}

export type CompileRepositoryInstallUxResult =
  | {
      readonly ok: true;
      readonly compiled: CompiledRepositoryInstallUx;
    }
  | {
      readonly ok: false;
      readonly diagnostic: RepositoryInstallUxDiagnostic;
    };

/**
 * Compile one exact repository proposal against one exact compatibility
 * report. The result contains only DB-owned InstallConfig shapes; callers must
 * persist it rather than reading the repository document again at Plan time.
 */
export function compileRepositoryInstallUx(
  input: CompileRepositoryInstallUxInput,
): CompileRepositoryInstallUxResult {
  const modulePath = canonicalModulePath(input.modulePath);
  if (!modulePath) {
    return invalid(
      "repository_install_ux_module_path_invalid",
      "The selected module path is not a canonical relative path.",
    );
  }
  const module = input.document.install.modules[modulePath];
  if (!module) {
    return invalid(
      "repository_install_ux_module_missing",
      `The repository install UX does not declare the selected module ${boundedIdentifier(modulePath)}.`,
    );
  }

  const reportModulePath = canonicalModulePath(
    input.compatibilityReport.modulePath ?? "",
  );
  if (
    input.compatibilityReport.sourceSnapshotId !== input.sourceSnapshotId ||
    !reportModulePath ||
    reportModulePath !== modulePath
  ) {
    return invalid(
      "repository_install_ux_compatibility_report_mismatch",
      "The compatibility report does not describe the selected source snapshot module.",
    );
  }
  if (input.compatibilityReport.level === "unsupported") {
    return invalid(
      "repository_install_ux_compatibility_report_unsupported",
      "The selected module is unsupported by the current compatibility policy.",
    );
  }

  const declarations = input.compatibilityReport.rootModuleVariableDeclarations;
  if (!declarations) {
    return invalid(
      "repository_install_ux_variable_metadata_unavailable",
      "The compatibility report predates exact variable type/default metadata; run a new compatibility check.",
    );
  }
  const declarationByName = new Map(
    declarations.map((declaration) => [declaration.name, declaration]),
  );
  const inputByName = new Map(
    module.inputs.map((declaration) => [declaration.name, declaration]),
  );
  const sourceKinds = new Set(
    input.policy?.allowedSourceKinds ?? SUPPORTED_SOURCE_KINDS,
  );
  const projectionKinds = new Set(
    input.policy?.allowedProjectionKinds ?? SUPPORTED_PROJECTION_KINDS,
  );

  for (const declaration of module.inputs) {
    const validation = validateInputDeclaration(
      declaration,
      declarationByName.get(declaration.name),
      sourceKinds,
    );
    if (validation) return validation;
  }

  const projections = module.installExperience?.projections ?? [];
  for (const projection of projections) {
    const validation = validateProjection(
      projection,
      declarationByName,
      projectionKinds,
      input.policy?.allowedOidcScopes,
    );
    if (validation) return validation;
  }

  const featureValidation = validateFeatures(module.inputs, module.features);
  if (featureValidation) return featureValidation;

  const reviewedVariables = input.reviewedVariables ?? {};
  for (const [name, value] of Object.entries(reviewedVariables)) {
    const declaration = inputByName.get(name);
    if (!declaration || declaration.source.kind !== "user") {
      return invalid(
        "repository_install_ux_variable_value_unsupported",
        `The reviewed value ${boundedIdentifier(name)} is not a declared user input.`,
      );
    }
    if (declaration.secret === true) {
      return invalid(
        "repository_install_ux_secret_materialization_required",
        `The secret input ${boundedIdentifier(name)} must use the host secret materialization boundary.`,
      );
    }
    const moduleDeclaration = declarationByName.get(name)!;
    const effectiveType = declaration.type ?? knownType(moduleDeclaration);
    if (!jsonValueMatchesType(value, effectiveType)) {
      return invalid(
        "repository_install_ux_variable_value_type_mismatch",
        `The reviewed value for ${boundedIdentifier(name)} does not match its declared type.`,
      );
    }
  }

  const activeOptionalFeatureInputs = new Set<string>();
  for (const feature of module.features ?? []) {
    if (
      feature.optional &&
      feature.inputs.some((name) => reviewedVariables[name] !== undefined)
    ) {
      for (const name of feature.inputs) activeOptionalFeatureInputs.add(name);
    }
  }
  const optionalFeatureInputs = new Set(
    (module.features ?? [])
      .filter((feature) => feature.optional)
      .flatMap((feature) => feature.inputs),
  );
  if (input.requireReviewedValues !== false) {
    for (const declaration of module.inputs) {
      if (declaration.source.kind !== "user") continue;
      if (declaration.secret === true) continue;
      const moduleDeclaration = declarationByName.get(declaration.name)!;
      const required = effectiveRequired(declaration, moduleDeclaration);
      if (!required || reviewedVariables[declaration.name] !== undefined) {
        continue;
      }
      if (
        optionalFeatureInputs.has(declaration.name) &&
        !activeOptionalFeatureInputs.has(declaration.name)
      ) {
        continue;
      }
      return invalid(
        "repository_install_ux_variable_value_missing",
        `The required user input ${boundedIdentifier(declaration.name)} is missing.`,
      );
    }
  }

  const variablePresentation = module.inputs.flatMap((declaration) => {
    if (declaration.source.kind === "module_default") return [];
    const moduleDeclaration = declarationByName.get(declaration.name)!;
    return [
      compileVariablePresentation(declaration, moduleDeclaration),
    ] satisfies readonly InstallConfigVariablePresentation[];
  });
  const variableMapping: Record<string, JsonValue> = {
    ...compileDerivedVariableMapping(module.inputs, {
      capsuleName: input.capsuleName,
      workspaceId: input.workspaceId,
    }),
  };
  for (const [name, value] of Object.entries(reviewedVariables)) {
    variableMapping[name] = value;
  }

  return {
    ok: true,
    compiled: {
      variablePresentation,
      installExperience: {
        ...(projections.length > 0
          ? { projections: projections.map(copyProjection) }
          : {}),
        ...(module.features && module.features.length > 0
          ? {
              features: module.features.map((feature) => ({
                id: feature.id,
                label: feature.label,
                optional: feature.optional,
                inputs: [...feature.inputs],
              })),
            }
          : {}),
        repositoryInstallUx: { status: "accepted" },
      },
      variableMapping,
      userVariableNames: module.inputs
        .filter((declaration) => declaration.source.kind === "user")
        .map((declaration) => declaration.name)
        .sort(),
    },
  };
}

function validateInputDeclaration(
  input: RepositoryInstallUxInput,
  moduleDeclaration: CapsuleRootModuleVariableDeclaration | undefined,
  allowedSourceKinds: ReadonlySet<RepositoryInstallUxInputSource["kind"]>,
): CompileRepositoryInstallUxResult | undefined {
  if (!allowedSourceKinds.has(input.source.kind)) {
    return invalid(
      "repository_install_ux_source_disallowed",
      `The input source for ${boundedIdentifier(input.name)} is not allowed by operator policy.`,
    );
  }
  if (input.name === PLAIN_ENV_VARIABLE) {
    return invalid(
      "repository_install_ux_plain_env_unsupported",
      "Repository install UX cannot expose the plain env map.",
    );
  }
  if (!moduleDeclaration) {
    return invalid(
      "repository_install_ux_variable_missing",
      `The declared input ${boundedIdentifier(input.name)} does not exist in the selected module.`,
    );
  }
  if (
    input.type &&
    moduleDeclaration.type !== "unknown" &&
    input.type !== moduleDeclaration.type
  ) {
    return invalid(
      "repository_install_ux_variable_type_mismatch",
      `The declared type for ${boundedIdentifier(input.name)} does not match the selected module.`,
    );
  }
  if (input.source.kind === "module_default" && !moduleDeclaration.hasDefault) {
    return invalid(
      "repository_install_ux_variable_default_mismatch",
      `The input ${boundedIdentifier(input.name)} requests module_default but the module has no default.`,
    );
  }
  if (
    input.source.kind === "user" &&
    input.required === true &&
    moduleDeclaration.hasDefault
  ) {
    return invalid(
      "repository_install_ux_variable_default_mismatch",
      `The input ${boundedIdentifier(input.name)} cannot be required because the module declares a default.`,
    );
  }
  if (
    input.source.kind === "user" &&
    input.required === false &&
    !moduleDeclaration.hasDefault
  ) {
    return invalid(
      "repository_install_ux_variable_default_mismatch",
      `The input ${boundedIdentifier(input.name)} cannot be optional because the module has no default.`,
    );
  }
  return undefined;
}

function validateProjection(
  projection: RepositoryInstallUxProjection,
  declarations: ReadonlyMap<string, CapsuleRootModuleVariableDeclaration>,
  allowedProjectionKinds: ReadonlySet<RepositoryInstallUxProjection["kind"]>,
  allowedOidcScopes: readonly string[] | undefined,
): CompileRepositoryInstallUxResult | undefined {
  if (!allowedProjectionKinds.has(projection.kind)) {
    return invalid(
      "repository_install_ux_projection_disallowed",
      `The ${projection.kind} projection is not allowed by operator policy.`,
    );
  }
  const variables = projectionVariables(projection);
  for (const variable of variables) {
    const declaration = declarations.get(variable);
    if (
      !declaration ||
      (declaration.type !== "unknown" && declaration.type !== "string")
    ) {
      return invalid(
        "repository_install_ux_projection_variable_invalid",
        `The ${projection.kind} projection references an absent or non-string module variable.`,
      );
    }
  }
  if (
    projection.kind === "public_endpoint" &&
    !projection.variables.url &&
    !projection.variables.subdomain
  ) {
    return invalid(
      "repository_install_ux_projection_variable_invalid",
      "A public_endpoint projection must declare a URL or subdomain variable.",
    );
  }
  if (projection.kind === "oidc_client") {
    const allowed = new Set(allowedOidcScopes ?? []);
    const scopes = projection.scopes ?? ["openid", "profile", "email"];
    if (
      !scopes.includes("openid") ||
      scopes.some((scope) => !allowed.has(scope))
    ) {
      return invalid(
        "repository_install_ux_oidc_scope_disallowed",
        "The OIDC projection requests a scope outside the Accounts operator allowlist.",
      );
    }
  }
  return undefined;
}

function validateFeatures(
  inputs: readonly RepositoryInstallUxInput[],
  features:
    | readonly {
        readonly id: string;
        readonly inputs: readonly string[];
      }[]
    | undefined,
): CompileRepositoryInstallUxResult | undefined {
  if (!features) return undefined;
  const inputsByName = new Map(inputs.map((input) => [input.name, input]));
  const claimed = new Set<string>();
  for (const feature of features) {
    for (const name of feature.inputs) {
      const input = inputsByName.get(name);
      if (!input || input.source.kind !== "user" || claimed.has(name)) {
        return invalid(
          "repository_install_ux_feature_input_invalid",
          `Feature ${boundedIdentifier(feature.id)} must reference unique accepted user inputs.`,
        );
      }
      claimed.add(name);
    }
  }
  return undefined;
}

function compileVariablePresentation(
  input: RepositoryInstallUxInput,
  moduleDeclaration: CapsuleRootModuleVariableDeclaration,
): InstallConfigVariablePresentation {
  const derivedDefault =
    input.source.kind === "capsule_name" ||
    input.source.kind === "workspace_scoped_capsule_name"
      ? { source: input.source.kind }
      : undefined;
  const type = input.type ?? knownType(moduleDeclaration);
  return {
    name: input.name,
    ...(type ? { type } : {}),
    ...(input.format ? { format: input.format } : {}),
    required: effectiveRequired(input, moduleDeclaration),
    ...(input.advanced !== undefined ? { advanced: input.advanced } : {}),
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
    ...(derivedDefault ? { defaultValue: derivedDefault } : {}),
    label: input.label,
    ...(input.helper ? { helper: input.helper } : {}),
    ...(input.placeholder ? { placeholder: input.placeholder } : {}),
  };
}

function effectiveRequired(
  input: RepositoryInstallUxInput,
  moduleDeclaration: CapsuleRootModuleVariableDeclaration,
): boolean {
  if (input.source.kind !== "user") return false;
  return input.required ?? !moduleDeclaration.hasDefault;
}

function knownType(
  declaration: CapsuleRootModuleVariableDeclaration,
): "string" | "number" | "boolean" | "json" | undefined {
  return declaration.type === "unknown" ? undefined : declaration.type;
}

function compileDerivedVariableMapping(
  inputs: readonly RepositoryInstallUxInput[],
  context: {
    readonly capsuleName: string;
    readonly workspaceId: string;
  },
): Readonly<Record<string, JsonValue>> {
  const mapping: Record<string, JsonValue> = {};
  for (const input of inputs) {
    if (input.source.kind === "capsule_name") {
      mapping[input.name] = capsuleSlug(context.capsuleName);
    } else if (input.source.kind === "workspace_scoped_capsule_name") {
      const base = capsuleSlug(context.capsuleName);
      const suffix = workspaceSlugSuffix(context.workspaceId);
      mapping[input.name] = suffix ? `${base}-${suffix}` : base;
    }
  }
  return mapping;
}

function copyProjection(
  projection: RepositoryInstallUxProjection,
): RepositoryInstallUxProjection {
  switch (projection.kind) {
    case "service_name":
      return { kind: "service_name", variable: projection.variable };
    case "public_endpoint":
      return {
        kind: "public_endpoint",
        variables: { ...projection.variables },
      };
    case "initial_secret":
      return {
        kind: "initial_secret",
        variable: projection.variable,
        ...(projection.secretKind ? { secretKind: projection.secretKind } : {}),
        ...(projection.optional !== undefined
          ? { optional: projection.optional }
          : {}),
      };
    case "oidc_client":
      return {
        kind: "oidc_client",
        variables: { ...projection.variables },
        callbackPath: projection.callbackPath,
        ...(projection.scopes ? { scopes: [...projection.scopes] } : {}),
      };
    case "artifact":
      return { kind: "artifact", variables: { ...projection.variables } };
  }
}

function projectionVariables(
  projection: RepositoryInstallUxProjection,
): readonly string[] {
  switch (projection.kind) {
    case "service_name":
      return [projection.variable];
    case "initial_secret":
      return [projection.variable];
    case "public_endpoint":
    case "oidc_client":
    case "artifact":
      return Object.values(projection.variables).filter(
        (value): value is string => typeof value === "string",
      );
  }
}

function jsonValueMatchesType(
  value: JsonValue,
  type: "string" | "number" | "boolean" | "json" | undefined,
): boolean {
  switch (type) {
    case undefined:
    case "json":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function canonicalModulePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === ".") return ".";
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.endsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    /^[A-Za-z]:/u.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed
    .split("/")
    .some((segment) => !segment || segment === "." || segment === "..")
    ? undefined
    : trimmed;
}

function capsuleSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "capsule"
  );
}

function workspaceSlugSuffix(value: string): string {
  return value
    .replace(/^workspace_/u, "")
    .replace(/[^a-z0-9-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 6)
    .toLowerCase();
}

function boundedIdentifier(value: string): string {
  const sanitized = value.replace(/[\0-\u001f\u007f]/gu, "");
  return JSON.stringify(sanitized.slice(0, 96));
}

function invalid(
  code: RepositoryInstallUxDiagnosticCode,
  message: string,
): CompileRepositoryInstallUxResult {
  return {
    ok: false,
    diagnostic: {
      code,
      message: message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    },
  };
}
