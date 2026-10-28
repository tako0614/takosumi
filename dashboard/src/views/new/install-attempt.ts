/**
 * Install attempt state (TASK-0115 Phase 3b) — pure: no JSX, no requests.
 *
 * The install-plan coordinator owns the whole attempt and tells the page the
 * one next thing the person can do (`userAction`). This module turns that
 * answer plus the little the page keeps for itself (whether a request is in
 * flight, what the person typed) into what the page shows: one stage, one
 * primary action, and the requests it may send.
 *
 * Invariants the page relies on:
 * - Opening a page sends nothing; the attempt starts only from Install.
 * - Applying is never a state of its own here: the review step owns the one
 *   "Allow and install" click.
 * - Only the attempt id may enter the URL. Inputs, setting values and secret
 *   values never do, and are never written to browser storage.
 * - Setting values are sent only in the confirming answer (`continue`).
 */
import type {
  CreateGitInstallAttemptRequest,
  GitInstallPlan,
  GitInstallPlanConnectionRequirement,
  GitInstallPlanInvalidation,
  GitInstallPlanProviderBindingRequest,
  GitInstallPlanResponse,
  GitInstallPlanUserAction,
  GitInstallPlanVariablePresentation,
  JsonValue,
} from "takosumi-contract";
import type { MessageKey } from "../../i18n/index.ts";

// --- URL ---------------------------------------------------------------------

const ATTEMPT_PARAM = "installPlan";
const ATTEMPT_ID = /^gip_[a-f0-9]{16}$/u;
/** Query keys that only describe which app this page is about. */
const CONTEXT_PARAMS = ["tcsBase", "tcsListing", ATTEMPT_PARAM] as const;

/** The attempt this URL names, when it names exactly one well-formed id. */
export function installAttemptId(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll(ATTEMPT_PARAM);
  return values.length === 1 && ATTEMPT_ID.test(values[0] ?? "")
    ? values[0]
    : undefined;
}

/**
 * The same query with the attempt locator set (or removed). Every other
 * parameter — the app's Git link, its Store listing, an app handoff — stays,
 * so a reload or a discard lands on the same app.
 */
export function withInstallAttempt(
  search: string,
  attemptId: string | undefined,
): string {
  const params = new URLSearchParams(search);
  params.delete(ATTEMPT_PARAM);
  if (attemptId !== undefined) {
    if (!ATTEMPT_ID.test(attemptId)) throw new TypeError("Invalid install attempt id");
    params.set(ATTEMPT_PARAM, attemptId);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The query without the locators, as the Git-link parser expects it. */
export function withoutInstallContext(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of CONTEXT_PARAMS) params.delete(key);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** An old `/new?capsule=<id>` locator: that app's page owns it now. */
export function legacyCapsuleLocator(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll("capsule");
  return values.length === 1 && /^cap_[A-Za-z0-9_-]{1,128}$/u.test(values[0] ?? "")
    ? values[0]
    : undefined;
}

// --- Starting -----------------------------------------------------------------

const APP_NAME = /^[a-z0-9-]+$/u;

/** A name the API accepts for an app, or undefined. */
export function appNameValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && trimmed.length <= 63 && APP_NAME.test(trimmed)
    ? trimmed
    : undefined;
}

/** `Repository Office` → `repository-office`, for a Store listing's name. */
export function appNameFromText(value: string): string | undefined {
  return appNameValue(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48)
      .replace(/-+$/u, ""),
  );
}

/** What the person chose before pressing Install. Nothing exists yet. */
export interface InstallCandidate {
  readonly url: string;
  /** The exact Git ref to read; empty means the repository default. */
  readonly ref: string;
  /** Git subtree the Source captures (`.` for the whole repository). */
  readonly sourcePath: string;
  /** A module the link or listing named; only a hint the scan must prove. */
  readonly modulePath: string;
  readonly name?: string;
  readonly authConnectionId?: string;
}

/** The value-free body that starts one attempt. */
export function attemptCreateRequest(
  candidate: InstallCandidate,
): CreateGitInstallAttemptRequest {
  const ref = candidate.ref.trim();
  const name = appNameValue(candidate.name);
  const modulePath = candidate.modulePath.trim();
  return {
    mode: "attempt",
    source: {
      url: candidate.url.trim(),
      ...(ref ? { ref } : {}),
      ...(candidate.sourcePath && candidate.sourcePath !== "."
        ? { path: candidate.sourcePath }
        : {}),
      ...(candidate.authConnectionId
        ? { authConnectionId: candidate.authConnectionId }
        : {}),
    },
    ...(name ? { capsule: { name } } : {}),
    ...(modulePath ? { options: { modulePath } } : {}),
  };
}

/**
 * Starting over after a failed or expired attempt reads the same app again:
 * same repository, version, module and name. Connection answers are chosen
 * again on the new sheet.
 */
export function restartRequest(
  plan: GitInstallPlan,
): CreateGitInstallAttemptRequest {
  return attemptCreateRequest({
    url: plan.source.url,
    ref: plan.source.ref,
    sourcePath: plan.source.path,
    modulePath: plan.options.modulePath ?? "",
    name: plan.capsule.name,
    ...(plan.source.authConnectionId
      ? { authConnectionId: plan.source.authConnectionId }
      : {}),
  });
}

/**
 * The attempt shown on this page must be this person's, in this workspace.
 * Anything else is not offered for any action.
 */
export function attemptBelongsHere(
  response: GitInstallPlanResponse,
  expected: {
    readonly attemptId: string;
    readonly workspaceId: string;
    readonly principalId: string;
  },
): boolean {
  const plan = response.installPlan;
  return Boolean(
    expected.attemptId &&
      expected.workspaceId &&
      expected.principalId &&
      plan.id === expected.attemptId &&
      plan.workspaceId === expected.workspaceId &&
      plan.createdBy === expected.principalId &&
      plan.mode === "attempt" &&
      plan.operation !== "revision",
  );
}

// --- Settings -----------------------------------------------------------------

/** What the person typed for one setting, held only in page memory. */
export interface VariableDraft {
  readonly value: string;
  /** False until the person edits the field; untouched defaults are not sent. */
  readonly touched: boolean;
}

export type VariableDrafts = Readonly<Record<string, VariableDraft>>;

type ProvideInputs = Extract<GitInstallPlanUserAction, { kind: "provide_inputs" }>;

/** The text a field starts with. Secret fields always start empty. */
export function variableInitialText(
  variable: GitInstallPlanVariablePresentation,
): string {
  if (variable.sensitive || variable.defaultValue === undefined) return "";
  const value = variable.defaultValue;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * True once the confirming answer was sent but its outcome is not known: the
 * app may already exist, so only the same settings may be sent again (the
 * list may be empty) and nothing else can change.
 */
export function awaitingResubmission(action: ProvideInputs): boolean {
  return action.resubmitVariables !== undefined;
}

/**
 * The settings this sheet asks for. While the attempt waits for re-sent
 * values only those are asked, as write-only fields.
 */
export function sheetVariables(
  action: ProvideInputs,
): readonly GitInstallPlanVariablePresentation[] {
  const resubmit = action.resubmitVariables;
  if (resubmit === undefined) return action.variables;
  return resubmit.map((name) => {
    const known = action.variables.find((variable) => variable.name === name);
    return {
      ...(known ?? { name, type: "unknown" as const }),
      required: true,
      sensitive: true,
    };
  });
}

function variableJsonValue(
  variable: GitInstallPlanVariablePresentation,
  text: string,
): JsonValue | undefined {
  switch (variable.type) {
    case "number": {
      const value = Number(text.trim());
      return text.trim() !== "" && Number.isFinite(value) ? value : undefined;
    }
    case "boolean":
      return text === "true" ? true : text === "false" ? false : undefined;
    case "json":
      try {
        return JSON.parse(text) as JsonValue;
      } catch {
        return undefined;
      }
    default:
      return text;
  }
}

export type ContinueVariables =
  | { readonly ok: true; readonly variables: Readonly<Record<string, JsonValue>> }
  | {
      readonly ok: false;
      readonly missing: readonly string[];
      readonly invalid: readonly string[];
    };

/**
 * The setting values for the confirming answer. A secret is sent only when
 * typed; an untouched literal or derived default is left to Takosumi; a
 * required setting must have a value.
 */
export function continueVariables(
  action: ProvideInputs,
  drafts: VariableDrafts,
): ContinueVariables {
  const variables: Record<string, JsonValue> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const variable of sheetVariables(action)) {
    const draft = drafts[variable.name];
    const text = variable.sensitive
      ? (draft?.value ?? "")
      : draft?.touched
        ? draft.value
        : "";
    if (text === "") {
      if (variable.required) missing.push(variable.name);
      continue;
    }
    const value = variableJsonValue(variable, text);
    if (value === undefined) invalid.push(variable.name);
    else variables[variable.name] = value;
  }
  return missing.length > 0 || invalid.length > 0
    ? { ok: false, missing, invalid }
    : { ok: true, variables };
}

// --- Connections ----------------------------------------------------------------

type ConnectionIdentity = Pick<
  GitInstallPlanConnectionRequirement,
  "provider" | "moduleLocalName" | "childAlias" | "rootAlias"
>;

/** Stable key for one provider requirement row. */
export function connectionKey(requirement: ConnectionIdentity): string {
  return [
    requirement.provider,
    requirement.moduleLocalName,
    requirement.childAlias ?? "",
    requirement.rootAlias ?? "",
  ].join("|");
}

function bindingFor(
  requirement: ConnectionIdentity,
  connectionId: string,
): GitInstallPlanProviderBindingRequest {
  return {
    provider: requirement.provider,
    moduleLocalName: requirement.moduleLocalName,
    ...(requirement.childAlias !== undefined ? { childAlias: requirement.childAlias } : {}),
    ...(requirement.rootAlias !== undefined ? { rootAlias: requirement.rootAlias } : {}),
    connectionId,
  };
}

/**
 * The complete explicit connection answer after choosing `connectionId` for
 * one row (empty clears it). Rows the coordinator filled in on its own stay
 * automatic; rows the person answered keep their answer.
 */
export function bindingsWith(
  connections: readonly GitInstallPlanConnectionRequirement[],
  target: ConnectionIdentity,
  connectionId: string,
): GitInstallPlanProviderBindingRequest[] {
  const targetKey = connectionKey(target);
  const bindings: GitInstallPlanProviderBindingRequest[] = [];
  for (const requirement of connections) {
    if (connectionKey(requirement) === targetKey) {
      if (connectionId) bindings.push(bindingFor(requirement, connectionId));
      continue;
    }
    if (requirement.selectedConnectionId && !requirement.autoSelected) {
      bindings.push(bindingFor(requirement, requirement.selectedConnectionId));
    }
  }
  return bindings;
}

/** The row's chosen connection, when it is still one of its live candidates. */
export function selectedCandidate(
  requirement: GitInstallPlanConnectionRequirement,
): GitInstallPlanConnectionRequirement["candidates"][number] | undefined {
  return requirement.candidates.find(
    (candidate) => candidate.id === requirement.selectedConnectionId,
  );
}

/** Rows that still need a connection before the sheet can continue. */
export function missingConnections(
  connections: readonly GitInstallPlanConnectionRequirement[],
): readonly GitInstallPlanConnectionRequirement[] {
  return connections.filter((requirement) => !selectedCandidate(requirement));
}

// --- The view -------------------------------------------------------------------

export type InstallStage =
  /** Nothing started; opening the page created nothing. */
  | "candidate"
  /** The starting request is in flight. */
  | "starting"
  /** The coordinator is reading the repository and this page follows it. */
  | "reading"
  /** The coordinator has work left, but this page is not following it. */
  | "paused"
  | "choose_module"
  | "provide_inputs"
  /** A Plan Run exists; the review owns approval and the apply click. */
  | "review"
  /** A step could not be confirmed and can simply be tried again. */
  | "retry"
  /** The attempt failed; only starting over continues. */
  | "failed"
  /** The attempt expired or its workspace changed while it waited. */
  | "invalidated"
  | "discarded"
  /** The attempt could not be read here. */
  | "unavailable";

/** The one primary action of a stage. */
export type InstallPrimary =
  | "install"
  | "continue"
  | "choose_module"
  | "connect"
  | "review"
  | "retry"
  | "restart"
  | "reinstall"
  | "reload"
  | "none";

export interface InstallLocalState {
  /** The starting request is in flight and no attempt exists yet. */
  readonly starting?: boolean;
  /** This page view is advancing the coordinator. */
  readonly driving?: boolean;
  /** A starting, answering or discarding request is in flight. */
  readonly mutating?: boolean;
  /** The attempt named by the URL could not be read. */
  readonly loadFailed?: boolean;
  readonly drafts?: VariableDrafts;
  /** The name typed in the sheet, when it differs from the attempt's. */
  readonly name?: string;
}

export interface InstallView {
  readonly stage: InstallStage;
  readonly primary: InstallPrimary;
  /** True while the primary action cannot be pressed yet. */
  readonly primaryBlocked: boolean;
  /** "Stop installing" is offered (it is refused while a request is in flight). */
  readonly canDiscard: boolean;
  readonly missingConnections: readonly GitInstallPlanConnectionRequirement[];
  readonly missingVariables: readonly string[];
  readonly invalidVariables: readonly string[];
  /** The name is taken or not a valid app name. */
  readonly nameProblem?: "conflict" | "invalid";
  readonly retryCode?: string;
  readonly invalidated?: GitInstallPlanInvalidation;
}

const NOTHING: Pick<
  InstallView,
  "missingConnections" | "missingVariables" | "invalidVariables"
> = { missingConnections: [], missingVariables: [], invalidVariables: [] };

/** What the page shows for one attempt answer and the page's own state. */
export function deriveInstallView(
  response: GitInstallPlanResponse | undefined,
  local: InstallLocalState = {},
): InstallView {
  const mutating = local.mutating === true;
  if (!response) {
    if (local.starting) {
      return { ...NOTHING, stage: "starting", primary: "none", primaryBlocked: true, canDiscard: false };
    }
    if (local.loadFailed) {
      return { ...NOTHING, stage: "unavailable", primary: "reload", primaryBlocked: false, canDiscard: false };
    }
    return { ...NOTHING, stage: "candidate", primary: "install", primaryBlocked: mutating, canDiscard: false };
  }
  const discardable = response.installPlan.phase !== "discarded" && !mutating;
  if (response.invalidated) {
    return {
      ...NOTHING,
      stage: "invalidated",
      primary: "restart",
      primaryBlocked: mutating,
      canDiscard: discardable,
      invalidated: response.invalidated,
    };
  }
  const action = response.userAction;
  switch (action.kind) {
    case "wait":
      return local.driving
        ? { ...NOTHING, stage: "reading", primary: "none", primaryBlocked: true, canDiscard: discardable }
        : { ...NOTHING, stage: "paused", primary: "continue", primaryBlocked: mutating, canDiscard: discardable };
    case "choose_module":
      return {
        ...NOTHING,
        stage: "choose_module",
        primary: "choose_module",
        primaryBlocked: mutating || action.modules.length === 0,
        canDiscard: discardable,
      };
    case "provide_inputs": {
      const resubmitting = awaitingResubmission(action);
      const missing = resubmitting ? [] : missingConnections(action.connections);
      const values = continueVariables(action, local.drafts ?? {});
      const typed = resubmitting ? undefined : local.name?.trim();
      const nameProblem = typed !== undefined && typed !== action.name.current
        ? (appNameValue(typed) ? undefined : "invalid")
        : action.name.conflict && !resubmitting
          ? "conflict"
          : undefined;
      return {
        stage: "provide_inputs",
        primary: missing.length > 0 ? "connect" : "review",
        primaryBlocked:
          mutating ||
          (missing.length === 0 && (!values.ok || nameProblem !== undefined)),
        canDiscard: discardable,
        missingConnections: missing,
        missingVariables: values.ok ? [] : values.missing,
        invalidVariables: values.ok ? [] : values.invalid,
        ...(nameProblem ? { nameProblem } : {}),
      };
    }
    case "review_run":
      return { ...NOTHING, stage: "review", primary: "none", primaryBlocked: true, canDiscard: discardable };
    case "retry":
      return action.restart
        ? { ...NOTHING, stage: "failed", primary: "restart", primaryBlocked: mutating, canDiscard: discardable, retryCode: action.code }
        : { ...NOTHING, stage: "retry", primary: "retry", primaryBlocked: mutating, canDiscard: discardable, retryCode: action.code };
    case "none":
      return response.installPlan.phase === "discarded"
        ? { ...NOTHING, stage: "discarded", primary: "reinstall", primaryBlocked: false, canDiscard: false }
        : { ...NOTHING, stage: "unavailable", primary: "reload", primaryBlocked: false, canDiscard: false };
  }
}

/** Short status of an unfinished attempt in the "途中のインストール" list. */
export function openAttemptStatusKey(response: GitInstallPlanResponse): MessageKey {
  switch (deriveInstallView(response).stage) {
    case "paused":
    case "retry":
      return "installStore.open.statusReading";
    case "choose_module":
    case "provide_inputs":
      return "installStore.open.statusInputs";
    case "review":
      return "installStore.open.statusReview";
    case "invalidated":
      return "installStore.open.statusExpired";
    default:
      return "installStore.open.statusFailed";
  }
}

// --- Words ------------------------------------------------------------------------

/** What happened, for a failed or invalidated attempt's code. */
export function attemptProblemKey(code: string | undefined): MessageKey {
  switch (code) {
    case "install_attempt_expired":
      return "installStore.problem.expired";
    case "workspace_management_changed":
      return "installStore.problem.workspaceChanged";
    case "source_sync_failed":
      return "installStore.problem.sourceSync";
    case "repository_install_module_index_unavailable":
    case "repository_install_module_missing":
    case "repository_install_module_unavailable":
    case "install_module_unavailable":
      return "installStore.problem.module";
    case "generic_opentofu_compatibility_not_ready":
    case "generic_opentofu_compatibility_analysis_failed":
    case "generic_opentofu_variable_declarations_missing":
    case "generic_opentofu_variable_declarations_invalid":
      return "installStore.problem.compatibility";
    case "repository_install_ux_secret_materialization_required":
      return "installStore.problem.secretSetting";
    case "plan_run_failed":
      return "installStore.problem.plan";
    case "install_plan_reconcile_retryable":
      return "installStore.problem.retryable";
    case "capsule_name_conflict":
      return "installStore.problem.nameTaken";
    case "provider_binding_invalid":
      return "installStore.problem.connection";
    case "install_inputs_resubmission_required":
      return "installStore.problem.resubmit";
    default:
      return "installStore.problem.generic";
  }
}

/** `https://github.com/o/r.git` → `github.com/o/r`, for the provenance line. */
export function repositoryLabel(url: string): string {
  return url.trim().replace(/^https:\/\//u, "").replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

/** A ref as a person reads it: a full commit shortened, `HEAD` hidden. */
export function versionLabel(ref: string | undefined): string | undefined {
  const value = ref?.trim();
  if (!value || value === "HEAD") return undefined;
  return /^[0-9a-f]{40}$/iu.test(value) ? value.slice(0, 7) : value;
}
