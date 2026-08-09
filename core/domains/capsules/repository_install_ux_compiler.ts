import type {
  CapsuleCompatibilityReport,
  CapsuleRootModuleOutputDeclaration,
  CapsuleRootModuleVariableDeclaration,
} from "takosumi-contract/capsules";
import type {
  CapsuleInterfaceBindingProposal,
  CapsuleInterfaceBlueprint,
  CapsuleInterfaceBlueprintInput,
  CapsuleRequiredInterface,
} from "takosumi-contract/interfaces";
import type {
  InstallConfig,
  InstallConfigHostRuntimeMaterialization,
  InstallConfigInstallExperience,
  InstallConfigInstallProjection,
  OutputAllowlistEntry,
  InstallConfigVariablePresentation,
} from "takosumi-contract/install-configs";
import type {
  RepositoryInterfaceBindingRequest,
  RepositoryInterfaceDeclaration,
  RepositoryInterfaceInput,
  RepositoryInterfaceOutputType,
  RepositoryInstallUxInput,
  RepositoryInstallUxInputSource,
  RepositoryRuntimeRequirement,
  RepositoryManifestDocument,
} from "takosumi-contract/repository-manifest";
import {
  deliversToVariables,
  deliveryTargets,
  findForbiddenRepositoryManifestMaterial,
  isRepositoryManifestInterfaceCapableApiVersion,
  parseRepositorySourceBuild,
  TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3,
} from "takosumi-contract/repository-manifest";
import { HOST_RUNTIME_MATERIALIZATION_CONTRACT } from "takosumi-contract";
import type { JsonValue } from "takosumi-contract/types";

const SUPPORTED_SOURCE_KINDS = [
  "user",
  "capsule_name",
  "workspace_scoped_capsule_name",
  "module_default",
] as const;

const SUPPORTED_REQUIREMENT_KINDS = [
  "identity.oidc",
  "secret.generated",
  "http.endpoint",
  "interface.consume",
] as const;

/**
 * Runtime binding names the host itself owns. A repository requirement may
 * never deliver into one, because the app would then receive a repository-
 * chosen value where it expects host authority.
 */
const RESERVED_RUNTIME_BINDINGS: ReadonlySet<string> = new Set([
  "TAKOFORM_ENDPOINT",
  "TAKOFORM_SPACE",
  "TAKOFORM_TOKEN",
  "TAKOSUMI_CAPSULE_ID",
  "TAKOSUMI_WORKSPACE_ID",
  "TAKOSUMI_RUN_ID",
]);

const DEFAULT_GENERATED_SECRET_BYTES = 32;
const DEFAULT_GENERATED_SECRET_ENCODING = "base64url" as const;

const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240;
const PLAIN_ENV_VARIABLE = "env";
const DEFAULT_INTERFACE_DELIVERY_TYPES = ["none"] as const;
const MAX_INTERFACE_PERMISSION_LENGTH = 256;
const MAX_INTERFACE_PERMISSIONS = 16;

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
  | "repository_install_ux_requirement_disallowed"
  | "repository_install_ux_requirement_target_invalid"
  | "repository_install_ux_oidc_scope_disallowed"
  | "repository_install_ux_feature_input_invalid"
  | "repository_install_ux_secret_materialization_required"
  | "repository_install_ux_interface_version_unsupported"
  | "repository_install_ux_interface_key_duplicate"
  | "repository_install_ux_interface_name_duplicate"
  | "repository_install_ux_interface_access_invalid"
  | "repository_install_ux_interface_input_invalid"
  | "repository_install_ux_interface_output_metadata_unavailable"
  | "repository_install_ux_interface_output_missing"
  | "repository_install_ux_interface_output_sensitive"
  | "repository_install_ux_interface_output_ephemeral"
  | "repository_install_ux_interface_output_secrecy_unknown"
  | "repository_install_ux_interface_output_type_conflict"
  | "repository_install_ux_interface_binding_invalid"
  | "repository_install_ux_interface_permission_disallowed"
  | "repository_install_ux_interface_delivery_disallowed"
  | "repository_install_ux_source_build_version_unsupported"
  | "repository_install_ux_source_build_invalid";

export interface RepositoryInstallUxDiagnostic {
  readonly code: RepositoryInstallUxDiagnosticCode;
  readonly message: string;
}

export interface RepositoryInstallUxCompilerPolicy {
  readonly allowedSourceKinds?: readonly RepositoryInstallUxInputSource["kind"][];
  readonly allowedRequirementKinds?: readonly RepositoryRuntimeRequirement["kind"][];
  readonly allowedOidcScopes?: readonly string[];
  /** Permission tokens accepted from repository-owned binding requests. */
  readonly allowedInterfacePermissions?: readonly string[];
  /** Delivery tokens accepted from repository-owned binding requests. */
  readonly allowedInterfaceDeliveryTypes?: readonly string[];
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
  /** Normalized Capsule-owned Interface proposals for later InstallConfig merge. */
  readonly interfaceBlueprints: readonly CapsuleInterfaceBlueprint[];
  /** Host Interface access requested by the Capsule runtime. */
  readonly requiredInterfaces: readonly CapsuleRequiredInterface[];
  /** Least-privilege Output projections required by those Interfaces. */
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  /** Credential-free source preparation persisted into InstallConfig. */
  readonly sourceBuild?: InstallConfig["sourceBuild"];
  /**
   * Requirements the repository asked the host to satisfy directly in the
   * application runtime. Absent when every requirement is delivered through
   * module variables instead.
   */
  readonly hostRuntimeMaterialization?: InstallConfigHostRuntimeMaterialization;
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

  // `sourceBuild` is a v2.3-only field. Keep this runtime check in addition to
  // the closed parser so manually constructed documents cannot smuggle it into
  // an older API version and accidentally widen the execution contract.
  const moduleWithSourceBuild = module as typeof module & {
    readonly sourceBuild?: unknown;
  };
  if (
    input.document.apiVersion !== TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3 &&
    moduleWithSourceBuild.sourceBuild !== undefined
  ) {
    return invalid(
      "repository_install_ux_source_build_version_unsupported",
      "Repository-owned sourceBuild requires takosumi.com/v2.3.",
    );
  }
  let sourceBuild: InstallConfig["sourceBuild"];
  if (
    input.document.apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3
  ) {
    const parsedSourceBuild = parseRepositorySourceBuild(
      moduleWithSourceBuild.sourceBuild,
      `install.modules.${JSON.stringify(modulePath)}.sourceBuild`,
    );
    if (typeof parsedSourceBuild === "string") {
      return invalid(
        "repository_install_ux_source_build_invalid",
        "The repository sourceBuild proposal is invalid.",
      );
    }
    sourceBuild = parsedSourceBuild;
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
  const requirementKinds = new Set(
    input.policy?.allowedRequirementKinds ?? SUPPORTED_REQUIREMENT_KINDS,
  );

  for (const declaration of module.inputs) {
    const validation = validateInputDeclaration(
      declaration,
      declarationByName.get(declaration.name),
      sourceKinds,
    );
    if (validation) return validation;
  }

  const requirements = module.requires ?? [];
  for (const requirement of requirements) {
    const validation = validateRequirement(
      requirement,
      declarationByName,
      requirementKinds,
      input.policy?.allowedOidcScopes,
      input.policy?.allowedInterfacePermissions,
      input.policy?.allowedInterfaceDeliveryTypes,
    );
    if (validation) return validation;
  }
  const roleValidation = validateRoles(module.inputs, declarationByName);
  if (roleValidation) return roleValidation;

  const featureValidation = validateFeatures(module.inputs, module.features);
  if (featureValidation) return featureValidation;

  const interfaceCompilation = compileInterfaceDeclarations({
    apiVersion: input.document.apiVersion,
    declarations: module.interfaces,
    outputDeclarations: input.compatibilityReport.rootModuleOutputs,
    policy: input.policy,
  });
  if (!interfaceCompilation.ok) return interfaceCompilation;

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

  const projections = compileVariableProjections(requirements, module.inputs);
  const hostRuntimeMaterialization = compileHostRuntimeMaterialization(
    requirements,
  );
  const requiredInterfaces = compileRequiredInterfaces(requirements);

  return {
    ok: true,
    compiled: {
      ...(hostRuntimeMaterialization ? { hostRuntimeMaterialization } : {}),
      variablePresentation,
      installExperience: {
        ...(projections.length > 0 ? { projections } : {}),
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
      ...(sourceBuild ? { sourceBuild } : {}),
      userVariableNames: module.inputs
        .filter((declaration) => declaration.source.kind === "user")
        .map((declaration) => declaration.name)
        .sort(),
      interfaceBlueprints: interfaceCompilation.interfaceBlueprints,
      requiredInterfaces,
      outputAllowlist: interfaceCompilation.outputAllowlist,
    },
  };
}

interface CompileInterfaceDeclarationsInput {
  readonly apiVersion: string;
  readonly declarations: readonly RepositoryInterfaceDeclaration[] | undefined;
  readonly outputDeclarations:
    | readonly CapsuleRootModuleOutputDeclaration[]
    | undefined;
  readonly policy: RepositoryInstallUxCompilerPolicy | undefined;
}

type CompileInterfaceDeclarationsResult =
  | {
      readonly ok: true;
      readonly interfaceBlueprints: readonly CapsuleInterfaceBlueprint[];
      readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
    }
  | {
      readonly ok: false;
      readonly diagnostic: RepositoryInstallUxDiagnostic;
    };

/**
 * Normalize repository-owned generic Interface proposals into the exact
 * service-side blueprint and Output projection shapes. This function does not
 * create a grant or add lifecycle authority; binding requests remain explicit
 * proposals for the existing InstallConfig materializer.
 */
function compileInterfaceDeclarations(
  input: CompileInterfaceDeclarationsInput,
): CompileInterfaceDeclarationsResult {
  const declarations = input.declarations ?? [];
  if (declarations.length === 0) {
    return { ok: true, interfaceBlueprints: [], outputAllowlist: {} };
  }
  if (!isRepositoryManifestInterfaceCapableApiVersion(input.apiVersion)) {
    return invalid(
      "repository_install_ux_interface_version_unsupported",
      "Repository-owned Interface declarations require takosumi.com/v2, v2.1, v2.2, or v2.3.",
    );
  }

  const names = new Set<string>();
  const keys = new Set<string>();
  const outputs = new Map<string, RepositoryInterfaceOutputType>();
  const outputDeclarations = input.outputDeclarations;
  const outputByName = new Map(
    (outputDeclarations ?? []).map((declaration) => [
      declaration.name,
      declaration,
    ]),
  );
  const normalized: CapsuleInterfaceBlueprint[] = [];

  for (const declaration of declarations) {
    if (keys.has(declaration.key)) {
      return invalid(
        "repository_install_ux_interface_key_duplicate",
        `The repository Interface key ${boundedIdentifier(declaration.key)} is declared more than once.`,
      );
    }
    if (names.has(declaration.name)) {
      return invalid(
        "repository_install_ux_interface_name_duplicate",
        `The repository Interface name ${boundedIdentifier(declaration.name)} is declared more than once.`,
      );
    }
    keys.add(declaration.key);
    names.add(declaration.name);

    if (declaration.spec.access.visibility !== "workspace") {
      return invalid(
        "repository_install_ux_interface_access_invalid",
        `Repository-owned Interface ${boundedIdentifier(declaration.name)} must use workspace visibility.`,
      );
    }
    if (declaration.spec.access.policyRef !== undefined) {
      return invalid(
        "repository_install_ux_interface_access_invalid",
        `Repository-owned Interface ${boundedIdentifier(declaration.name)} cannot supply host policyRef.`,
      );
    }
    if (
      declaration.spec.access.resourceUriInput !== undefined &&
      (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(
        declaration.spec.access.resourceUriInput,
      ) ||
        !Object.prototype.hasOwnProperty.call(
          declaration.spec.inputs ?? {},
          declaration.spec.access.resourceUriInput,
        ))
    ) {
      return invalid(
        "repository_install_ux_interface_access_invalid",
        `Repository-owned Interface ${boundedIdentifier(declaration.name)} resourceUriInput must name a declared Interface input.`,
      );
    }

    const inputs: Record<string, CapsuleInterfaceBlueprintInput> = {};
    for (const [inputName, source] of Object.entries(
      declaration.spec.inputs ?? {},
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const compiledInput = compileInterfaceInput({
        inputName,
        source,
        outputDeclarations,
        outputByName,
        outputs,
      });
      if (!compiledInput.ok) return compiledInput;
      inputs[inputName] = compiledInput.input;
    }

    const bindings = compileInterfaceBindingRequests(
      declaration.bindingRequests,
      input.policy,
    );
    if (!bindings.ok) return bindings;
    if (findForbiddenRepositoryManifestMaterial(declaration.spec.document)) {
      return invalid(
        "repository_install_ux_interface_input_invalid",
        `The Interface ${boundedIdentifier(declaration.name)} document contains a secret or authority field.`,
      );
    }
    normalized.push({
      key: declaration.key,
      name: declaration.name,
      spec: {
        type: declaration.spec.type,
        version: declaration.spec.version,
        document: declaration.spec.document,
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        access: declaration.spec.access,
      },
      ...(bindings.bindings.length > 0 ? { bindings: bindings.bindings } : {}),
    });
  }

  const outputAllowlist: Record<string, OutputAllowlistEntry> = {};
  for (const outputName of [...outputs.keys()].sort()) {
    const outputType = outputs.get(outputName)!;
    outputAllowlist[outputName] = {
      from: outputName,
      type: outputType,
      required: true,
    };
  }
  normalized.sort((left, right) => left.key.localeCompare(right.key));
  return {
    ok: true,
    interfaceBlueprints: normalized,
    outputAllowlist,
  };
}

type CompiledCapsuleBlueprintInput = CapsuleInterfaceBlueprintInput;

function compileInterfaceInput(input: {
  readonly inputName: string;
  readonly source: RepositoryInterfaceInput;
  readonly outputDeclarations:
    | readonly CapsuleRootModuleOutputDeclaration[]
    | undefined;
  readonly outputByName: ReadonlyMap<
    string,
    CapsuleRootModuleOutputDeclaration
  >;
  readonly outputs: Map<string, RepositoryInterfaceOutputType>;
}):
  | { readonly ok: true; readonly input: CompiledCapsuleBlueprintInput }
  | { readonly ok: false; readonly diagnostic: RepositoryInstallUxDiagnostic } {
  if (input.source.source === "literal") {
    if (findForbiddenRepositoryManifestMaterial(input.source.value)) {
      return invalid(
        "repository_install_ux_interface_input_invalid",
        `The literal Interface input ${boundedIdentifier(input.inputName)} contains a secret or authority field.`,
      );
    }
    return {
      ok: true,
      input: { source: "literal", value: input.source.value },
    };
  }

  const outputName = input.source.outputName;
  const outputType = input.source.outputType;
  if (
    typeof outputName !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(outputName)
  ) {
    return invalid(
      "repository_install_ux_interface_input_invalid",
      `The Interface input ${boundedIdentifier(input.inputName)} references an invalid OpenTofu Output name.`,
    );
  }
  if (
    ![
      "string",
      "url",
      "hostname",
      "number",
      "boolean",
      "json",
    ].includes(outputType)
  ) {
    return invalid(
      "repository_install_ux_interface_input_invalid",
      `The Interface input ${boundedIdentifier(input.inputName)} requests an unsupported Output type.`,
    );
  }
  const declaration = input.outputByName.get(outputName);
  if (input.outputDeclarations === undefined) {
    return invalid(
      "repository_install_ux_interface_output_metadata_unavailable",
      `The exact compatibility report has no Output metadata for ${boundedIdentifier(outputName)}.`,
    );
  }
  if (!declaration) {
    return invalid(
      "repository_install_ux_interface_output_missing",
      `The Interface input ${boundedIdentifier(input.inputName)} references missing Output ${boundedIdentifier(outputName)}.`,
    );
  }
  if (declaration.sensitive === true) {
    return invalid(
      "repository_install_ux_interface_output_sensitive",
      `The Interface input ${boundedIdentifier(input.inputName)} references sensitive Output ${boundedIdentifier(outputName)}.`,
    );
  }
  if (declaration.ephemeral === true) {
    return invalid(
      "repository_install_ux_interface_output_ephemeral",
      `The Interface input ${boundedIdentifier(input.inputName)} references ephemeral Output ${boundedIdentifier(outputName)}.`,
    );
  }
  if (declaration.sensitive !== false) {
    return invalid(
      "repository_install_ux_interface_output_secrecy_unknown",
      `The secrecy of Output ${boundedIdentifier(outputName)} is unknown; the Interface declaration is rejected.`,
    );
  }
  if (declaration.ephemeral !== false) {
    return invalid(
      "repository_install_ux_interface_output_secrecy_unknown",
      `The ephemerality of Output ${boundedIdentifier(outputName)} is unknown; the Interface declaration is rejected.`,
    );
  }
  const priorType = input.outputs.get(outputName);
  if (priorType !== undefined && priorType !== outputType) {
    return invalid(
      "repository_install_ux_interface_output_type_conflict",
      `Output ${boundedIdentifier(outputName)} is requested with conflicting public types.`,
    );
  }
  input.outputs.set(outputName, outputType);
  return {
    ok: true,
    input: { source: "capsule_output", outputName },
  };
}

function compileInterfaceBindingRequests(
  requests: readonly RepositoryInterfaceBindingRequest[] | undefined,
  policy: RepositoryInstallUxCompilerPolicy | undefined,
):
  | {
      readonly ok: true;
      readonly bindings: readonly CapsuleInterfaceBindingProposal[];
    }
  | { readonly ok: false; readonly diagnostic: RepositoryInstallUxDiagnostic } {
  const normalized: CapsuleInterfaceBindingProposal[] = [];
  const keys = new Set<string>();
  const allowedPermissions = policy?.allowedInterfacePermissions;
  const allowedDeliveryTypes = new Set(
    policy?.allowedInterfaceDeliveryTypes ?? DEFAULT_INTERFACE_DELIVERY_TYPES,
  );
  if (
    (requests?.length ?? 0) > 0 &&
    (!allowedPermissions || allowedPermissions.length === 0)
  ) {
    return invalid(
      "repository_install_ux_interface_permission_disallowed",
      "Repository-owned Interface bindings require an explicit non-empty operator permission allowlist.",
    );
  }
  if ((requests?.length ?? 0) > 1) {
    return invalid(
      "repository_install_ux_interface_binding_invalid",
      "Repository-owned Interfaces may request at most one installing_principal binding.",
    );
  }
  for (const request of requests ?? []) {
    if (keys.has(request.key)) {
      return invalid(
        "repository_install_ux_interface_binding_invalid",
        `The Interface binding request key ${boundedIdentifier(request.key)} is declared more than once.`,
      );
    }
    keys.add(request.key);
    if (
      !request.subject ||
      request.subject.source !== "installing_principal"
    ) {
      return invalid(
        "repository_install_ux_interface_binding_invalid",
        "Repository-owned Interface bindings may target only installing_principal.",
      );
    }
    if (
      !Array.isArray(request.permissions) ||
      request.permissions.length < 1 ||
      request.permissions.length > MAX_INTERFACE_PERMISSIONS
    ) {
      return invalid(
        "repository_install_ux_interface_binding_invalid",
        `Interface binding ${boundedIdentifier(request.key)} must contain between 1 and ${MAX_INTERFACE_PERMISSIONS} permissions.`,
      );
    }
    const permissions = new Set<string>();
    for (const permission of request.permissions) {
      if (
        typeof permission !== "string" ||
        permission.length < 1 ||
        permission.length > MAX_INTERFACE_PERMISSION_LENGTH ||
        !/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(permission)
      ) {
        return invalid(
          "repository_install_ux_interface_binding_invalid",
          `Interface binding ${boundedIdentifier(request.key)} contains an invalid permission token.`,
        );
      }
      if (permissions.has(permission)) {
        return invalid(
          "repository_install_ux_interface_binding_invalid",
          `Interface binding ${boundedIdentifier(request.key)} repeats a permission token.`,
        );
      }
      permissions.add(permission);
      if (allowedPermissions && !allowedPermissions.includes(permission)) {
        return invalid(
          "repository_install_ux_interface_permission_disallowed",
          `Interface permission ${boundedIdentifier(permission)} is not allowed by operator policy.`,
        );
      }
    }
    const deliveryType = request.delivery?.type;
    if (
      typeof deliveryType !== "string" ||
      deliveryType.length < 1 ||
      deliveryType.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(deliveryType) ||
      !allowedDeliveryTypes.has(deliveryType)
    ) {
      return invalid(
        "repository_install_ux_interface_delivery_disallowed",
        `Interface binding ${boundedIdentifier(request.key)} requests a delivery type outside operator policy.`,
      );
    }
    // The manifest type intentionally has no credentialRef/options fields. The
    // runtime check keeps manually constructed documents fail-closed too.
    if (Object.keys(request.delivery ?? {}).some((key) => key !== "type")) {
      return invalid(
        "repository_install_ux_interface_binding_invalid",
        `Interface binding ${boundedIdentifier(request.key)} cannot carry credential, target, or provider fields.`,
      );
    }
    normalized.push({
      key: request.key,
      subject: { source: "installing_principal" },
      permissions: [...permissions].sort(),
      delivery: { type: deliveryType },
    });
  }
  normalized.sort((left, right) => left.key.localeCompare(right.key));
  return { ok: true, bindings: normalized };
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

function validateRequirement(
  requirement: RepositoryRuntimeRequirement,
  declarations: ReadonlyMap<string, CapsuleRootModuleVariableDeclaration>,
  allowedKinds: ReadonlySet<RepositoryRuntimeRequirement["kind"]>,
  allowedOidcScopes: readonly string[] | undefined,
  allowedInterfacePermissions: readonly string[] | undefined,
  allowedInterfaceDeliveryTypes: readonly string[] | undefined,
): CompileRepositoryInstallUxResult | undefined {
  if (!allowedKinds.has(requirement.kind)) {
    return invalid(
      "repository_install_ux_requirement_disallowed",
      `The ${requirement.kind} requirement is not allowed by operator policy.`,
    );
  }
  if (requirement.kind === "interface.consume") {
    if (!allowedInterfacePermissions?.length) {
      return invalid(
        "repository_install_ux_interface_permission_disallowed",
        "Consumed Interfaces require an explicit non-empty operator permission allowlist.",
      );
    }
    if (
      requirement.permissions.some(
        (permission) => !allowedInterfacePermissions.includes(permission),
      )
    ) {
      return invalid(
        "repository_install_ux_interface_permission_disallowed",
        `Consumed Interface ${boundedIdentifier(requirement.key)} requests a permission outside operator policy.`,
      );
    }
    const allowedDeliveryTypes = new Set(
      allowedInterfaceDeliveryTypes ?? DEFAULT_INTERFACE_DELIVERY_TYPES,
    );
    if (!allowedDeliveryTypes.has(requirement.delivery.type)) {
      return invalid(
        "repository_install_ux_interface_delivery_disallowed",
        `Consumed Interface ${boundedIdentifier(requirement.key)} requests a delivery type outside operator policy.`,
      );
    }
    return undefined;
  }
  const targets = deliveryTargets(requirement.deliver);
  if (deliversToVariables(requirement.deliver)) {
    // Variable delivery writes the module's own inputs, so each named variable
    // must exist and be able to hold a string.
    for (const variable of Object.values(targets)) {
      const declaration = declarations.get(variable);
      if (
        !declaration ||
        (declaration.type !== "unknown" && declaration.type !== "string")
      ) {
        return invalid(
          "repository_install_ux_requirement_target_invalid",
          `The ${requirement.kind} requirement references an absent or non-string module variable.`,
        );
      }
    }
  } else {
    // Binding delivery writes the application's runtime environment, where a
    // repository must not be able to occupy a host-reserved name.
    for (const binding of Object.values(targets)) {
      if (RESERVED_RUNTIME_BINDINGS.has(binding)) {
        return invalid(
          "repository_install_ux_requirement_target_invalid",
          `The runtime binding ${boundedIdentifier(binding)} is reserved by the host.`,
        );
      }
    }
  }
  if (
    requirement.kind === "http.endpoint" &&
    !targets.url &&
    !targets.subdomain
  ) {
    return invalid(
      "repository_install_ux_requirement_target_invalid",
      "An http.endpoint requirement must name a url or subdomain target.",
    );
  }
  if (requirement.kind === "identity.oidc") {
    const allowed = new Set(allowedOidcScopes ?? []);
    const scopes = requirement.scopes ?? ["openid", "profile", "email"];
    if (
      !scopes.includes("openid") ||
      scopes.some((scope: string) => !allowed.has(scope))
    ) {
      return invalid(
        "repository_install_ux_oidc_scope_disallowed",
        "The OIDC requirement requests a scope outside the Accounts operator allowlist.",
      );
    }
    if (!deliversToVariables(requirement.deliver)) {
      // A runtime receives sealed OIDC material as a whole or not at all: a
      // partial set would leave the app with an unusable half-configuration.
      const missing = (
        ["issuerUrl", "clientId", "ownerSubject", "redirectUri"] as const
      ).filter((slot) => !targets[slot]);
      if (missing.length > 0) {
        return invalid(
          "repository_install_ux_requirement_target_invalid",
          `An identity.oidc requirement delivered to bindings must name every binding; missing ${missing.join(", ")}.`,
        );
      }
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

/**
 * A declared role must name a real string variable, exactly like a requirement
 * that delivers to variables. The role only says what the field means.
 */
function validateRoles(
  inputs: readonly RepositoryInstallUxInput[],
  declarations: ReadonlyMap<string, CapsuleRootModuleVariableDeclaration>,
): CompileRepositoryInstallUxResult | undefined {
  for (const input of inputs) {
    if (!input.role) continue;
    const declaration = declarations.get(input.name);
    if (
      !declaration ||
      (declaration.type !== "unknown" && declaration.type !== "string")
    ) {
      return invalid(
        "repository_install_ux_requirement_target_invalid",
        `The ${input.role} role references an absent or non-string module variable.`,
      );
    }
  }
  return undefined;
}

/**
 * Variable-delivered requirements and input roles become the DB-owned
 * presentation projections the installer and Accounts already consume.
 */
function compileVariableProjections(
  requirements: readonly RepositoryRuntimeRequirement[],
  inputs: readonly RepositoryInstallUxInput[],
): readonly InstallConfigInstallProjection[] {
  const projections: InstallConfigInstallProjection[] = [];
  for (const input of inputs) {
    if (input.role === "service_name") {
      projections.push({ kind: "service_name", variable: input.name });
    } else if (input.role === "initial_secret") {
      projections.push({
        kind: "initial_secret",
        variable: input.name,
        ...(input.required === false ? { optional: true } : {}),
      });
    }
  }
  for (const requirement of requirements) {
    if (requirement.kind === "interface.consume") continue;
    if (!deliversToVariables(requirement.deliver)) continue;
    const variables = deliveryTargets(requirement.deliver);
    if (requirement.kind === "http.endpoint") {
      projections.push({ kind: "public_endpoint", variables: { ...variables } });
      continue;
    }
    if (requirement.kind === "identity.oidc") {
      projections.push({
        kind: "oidc_client",
        variables: { ...variables },
        callbackPath: requirement.callbackPath,
        ...(requirement.scopes
          ? { scopes: canonicalOidcScopes(requirement.scopes) }
          : {}),
      });
    }
    // A generated secret has no variable form: the host never writes a secret
    // into portable module state.
  }
  return projections;
}

function oidcBinding(binding: string): {
  readonly binding: string;
  readonly capabilityRef: `capability:${string}`;
} {
  return {
    binding,
    capabilityRef: `capability:repository/${binding}`,
  };
}

/**
 * Binding-delivered requirements become the provider-neutral host runtime
 * declaration. Values never appear here — only the opaque refs the host
 * resolves inside its own boundary.
 */
function compileHostRuntimeMaterialization(
  requirements: readonly RepositoryRuntimeRequirement[],
): InstallConfigHostRuntimeMaterialization | undefined {
  const materialized = requirements.filter(
    (
      requirement,
    ): requirement is Exclude<
      RepositoryRuntimeRequirement,
      { readonly kind: "interface.consume" }
    > =>
      requirement.kind !== "interface.consume" &&
      !deliversToVariables(requirement.deliver),
  );
  if (materialized.length === 0) return undefined;
  const compiled: InstallConfigHostRuntimeMaterialization["requirements"][number][] =
    [];
  for (const requirement of materialized) {
    const targets = deliveryTargets(requirement.deliver);
    if (requirement.kind === "secret.generated") {
      const binding = targets.value!;
      compiled.push({
        kind: "generated_secret",
        binding,
        secretRef: `secret:repository/${binding}`,
        bytes: requirement.bytes ?? DEFAULT_GENERATED_SECRET_BYTES,
        encoding: requirement.encoding ?? DEFAULT_GENERATED_SECRET_ENCODING,
      });
      continue;
    }
    if (requirement.kind === "identity.oidc") {
      compiled.push({
        kind: "public_oidc",
        id: "repository-oidc",
        callbackPath: requirement.callbackPath,
        scopes: canonicalOidcScopes(
          requirement.scopes ?? ["openid", "profile"],
        ),
        bindings: {
          issuerUrl: oidcBinding(targets.issuerUrl!),
          clientId: oidcBinding(targets.clientId!),
          ownerSubject: oidcBinding(targets.ownerSubject!),
          redirectUri: oidcBinding(targets.redirectUri!),
        },
      });
    }
    // http.endpoint has no binding form: the managed hostname is the runtime
    // location itself, not a value the host injects.
  }
  if (compiled.length === 0) return undefined;
  return {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    requirements: compiled,
  };
}

function compileRequiredInterfaces(
  requirements: readonly RepositoryRuntimeRequirement[],
): readonly CapsuleRequiredInterface[] {
  return requirements
    .filter(
      (
        requirement,
      ): requirement is Extract<
        RepositoryRuntimeRequirement,
        { readonly kind: "interface.consume" }
      > => requirement.kind === "interface.consume",
    )
    .map((requirement) => ({
      key: requirement.key,
      interface: { ...requirement.interface },
      permissions: [...new Set(requirement.permissions)].sort(),
      delivery: { type: requirement.delivery.type },
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * OAuth scopes are a set, while the host runtime contract stores sets in one
 * deterministic order. Repository metadata may use any order, so canonicalize
 * it at the repository-to-host authority seam before persistence validation.
 */
function canonicalOidcScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes)].sort();
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
): {
  readonly ok: false;
  readonly diagnostic: RepositoryInstallUxDiagnostic;
} {
  return {
    ok: false,
    diagnostic: {
      code,
      message: message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    },
  };
}
