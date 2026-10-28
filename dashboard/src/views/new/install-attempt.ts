/**
 * Install attempt state (TASK-0115) — pure: no JSX, no requests.
 *
 * The install-plan coordinator owns the whole attempt and tells the page the
 * one next thing it needs (`userAction`). This module turns that answer plus
 * the little the page keeps for itself (whether a request is in flight, what
 * the person typed, whether they changed something after the Plan) into what
 * the one install screen shows: its progress line, why 「許可してインストール」
 * cannot be pressed yet, and the requests the page may send.
 *
 * Invariants the page relies on:
 * - Opening a page sends nothing; the attempt starts only from Install.
 * - Applying is never a state of its own here: the review owns the one
 *   「許可してインストール」 click. A Plan is made on its own once nothing is
 *   missing; it creates nothing in the cloud.
 * - Only the attempt id may enter the URL. Inputs, setting values and secret
 *   values never do, and are never written to browser storage.
 * - Setting values are sent only in the confirming answer (`continue`).
 */
import type {
  CreateGitInstallAttemptRequest,
  GitInstallPlan,
  GitInstallPlanConnectionRequirement,
  GitInstallPlanInterfaceChoice,
  GitInstallPlanInterfaceLinkRequest,
  GitInstallPlanInterfaceRequirement,
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

/** Inputs for starting an install or recreating an existing attempt. */
export interface InstallCandidate {
  readonly url: string;
  /** The exact Git ref to read; empty means the repository default. */
  readonly ref: string;
  /** Git subtree the Source captures (`.` for the whole repository). */
  readonly sourcePath: string;
  /** A module the link or listing named; only a hint the scan must prove. */
  readonly modulePath: string;
  readonly name?: string;
  /** An existing attempt's environment; omitted on a brand-new install. */
  readonly environment?: string;
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
    ...(name || candidate.environment !== undefined
      ? {
          capsule: {
            ...(name ? { name } : {}),
            ...(candidate.environment !== undefined ? { environment: candidate.environment } : {}),
          },
        }
      : {}),
    ...(modulePath ? { options: { modulePath } } : {}),
  };
}

/**
 * Starting over after a failed or expired attempt reads the same app again:
 * same repository, version, module, name and environment. Connection answers
 * are chosen again on the new sheet.
 */
export function restartRequest(
  plan: GitInstallPlan,
): CreateGitInstallAttemptRequest {
  const base = attemptCreateRequest({
    url: plan.source.url,
    ref: plan.source.ref,
    sourcePath: plan.source.path,
    modulePath: plan.options.modulePath ?? "",
    name: plan.capsule.name,
    environment: plan.capsule.environment,
    ...(plan.source.authConnectionId
      ? { authConnectionId: plan.source.authConnectionId }
      : {}),
  });
  const explicit = plan.options.interfaceLinks?.filter((answer) =>
    !plan.implicitInterfaceKeys?.includes(answer.requirementKey)
  );
  return explicit !== undefined
    ? { ...base, options: { ...base.options, interfaceLinks: explicit } }
    : base;
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

/** A connection the person chose after the sheet went behind (key → id; "" clears). */
export type ConnectionOverrides = Readonly<Record<string, string>>;

/**
 * The rows as the person last chose them: the coordinator's selection, with
 * any choice made after the Plan existed applied on top.
 */
export function withConnectionOverrides(
  connections: readonly GitInstallPlanConnectionRequirement[],
  overrides: ConnectionOverrides,
): readonly GitInstallPlanConnectionRequirement[] {
  return connections.map((requirement) => {
    const key = connectionKey(requirement);
    if (!Object.hasOwn(overrides, key)) return requirement;
    const { selectedConnectionId: _selected, ...rest } = requirement;
    const chosen = overrides[key];
    return chosen
      ? { ...rest, selectedConnectionId: chosen, autoSelected: false }
      : { ...rest, autoSelected: false };
  });
}

/**
 * Every connection answer a new attempt starts with when the install is
 * prepared again: each row's chosen connection, whether the person or the
 * coordinator chose it.
 */
export function retainedBindings(
  connections: readonly GitInstallPlanConnectionRequirement[],
): GitInstallPlanProviderBindingRequest[] {
  return connections.flatMap((requirement) =>
    requirement.selectedConnectionId
      ? [bindingFor(requirement, requirement.selectedConnectionId)]
      : []
  );
}

function bindingKey(binding: GitInstallPlanProviderBindingRequest): string {
  return `${connectionKey(binding)}=${binding.connectionId}`;
}

/** Two connection answers name the same connection for the same rows. */
export function sameBindings(
  left: readonly GitInstallPlanProviderBindingRequest[],
  right: readonly GitInstallPlanProviderBindingRequest[],
): boolean {
  const a = left.map(bindingKey).sort();
  const b = right.map(bindingKey).sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * The rows of a new sheet shown with a connection answer the attempt has
 * not received yet (a row the answer leaves out shows as cleared).
 */
export function overridesForBindings(
  connections: readonly GitInstallPlanConnectionRequirement[],
  bindings: readonly GitInstallPlanProviderBindingRequest[],
): ConnectionOverrides {
  const overrides: Record<string, string> = {};
  for (const requirement of connections) {
    const key = connectionKey(requirement);
    overrides[key] = bindings.find((binding) => connectionKey(binding) === key)?.connectionId ?? "";
  }
  return overrides;
}

// --- Linked apps ---------------------------------------------------------------

/** A live Interface choice. Compatibility and permissions belong to the coordinator. */
export function selectedInterfaceCandidate(requirement: GitInstallPlanInterfaceRequirement) {
  const choice = requirement.choice;
  return choice?.kind === "interface"
    ? requirement.candidates.find((candidate) => candidate.id === choice.interfaceId)
    : undefined;
}

export function missingInterfaces(
  interfaces: readonly GitInstallPlanInterfaceRequirement[],
): readonly GitInstallPlanInterfaceRequirement[] {
  return interfaces.filter((requirement) => requirement.choice?.kind !== "later" && !selectedInterfaceCandidate(requirement));
}

/** Full explicit answer; automatic choices remain the coordinator's responsibility. */
export function interfaceLinksWith(
  interfaces: readonly GitInstallPlanInterfaceRequirement[],
  requirementKey: string,
  choice: GitInstallPlanInterfaceChoice | undefined,
  explicitLinks: readonly GitInstallPlanInterfaceLinkRequest[] = [],
): GitInstallPlanInterfaceLinkRequest[] {
  return interfaces.flatMap((requirement) => {
    const chosen = requirement.requirementKey === requirementKey
      ? choice
      : retainedInterfaceLinks([requirement], explicitLinks)[0]?.choice;
    return chosen ? [{ requirementKey: requirement.requirementKey, choice: chosen }] : [];
  });
}

export type InterfaceOverrides = Readonly<Record<string, GitInstallPlanInterfaceChoice | undefined>>;

export function withInterfaceOverrides(
  interfaces: readonly GitInstallPlanInterfaceRequirement[],
  overrides: InterfaceOverrides,
): readonly GitInstallPlanInterfaceRequirement[] {
  return interfaces.map((requirement) => Object.hasOwn(overrides, requirement.requirementKey)
    ? { ...requirement, choice: overrides[requirement.requirementKey], autoSelected: false }
    : requirement);
}

export function retainedInterfaceLinks(
  interfaces: readonly GitInstallPlanInterfaceRequirement[],
  explicitLinks: readonly GitInstallPlanInterfaceLinkRequest[] = [],
): GitInstallPlanInterfaceLinkRequest[] {
  return interfaces.flatMap((requirement) => requirement.choice && !requirement.autoSelected && (
    requirement.choice.kind !== "later" || requirement.candidates.length > 0 ||
    explicitLinks.some((link) => link.requirementKey === requirement.requirementKey)
  )
    ? [{ requirementKey: requirement.requirementKey, choice: requirement.choice }]
    : []);
}

export function sameInterfaceLinks(
  left: readonly GitInstallPlanInterfaceLinkRequest[],
  right: readonly GitInstallPlanInterfaceLinkRequest[],
): boolean {
  const keys = (links: readonly GitInstallPlanInterfaceLinkRequest[]) => links.map(({ requirementKey, choice }) =>
    JSON.stringify([requirementKey, choice.kind, choice.kind === "interface" ? choice.interfaceId : ""])).sort();
  const a = keys(left);
  const b = keys(right);
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

export function overridesForInterfaceLinks(
  interfaces: readonly GitInstallPlanInterfaceRequirement[],
  links: readonly GitInstallPlanInterfaceLinkRequest[],
): InterfaceOverrides {
  return Object.fromEntries(interfaces.flatMap((requirement) => {
    const chosen = links.find((link) => link.requirementKey === requirement.requirementKey);
    return chosen || (!requirement.autoSelected && !(requirement.choice?.kind === "later" && requirement.candidates.length === 0))
      ? [[requirement.requirementKey, chosen?.choice]] : [];
  }));
}

/** What the install keeps when it is prepared again after a change. */
export interface RetainedAnswers {
  /** The app name the person wants. */
  readonly name: string;
  /** The version to read; the attempt's own when unchanged. */
  readonly ref: string;
  readonly modulePath?: string;
  readonly providerBindings: readonly GitInstallPlanProviderBindingRequest[];
  readonly interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[];
}

/**
 * The value-free body of the attempt that replaces one whose Plan went out
 * of date: the same repository and Git connection, with the name, version,
 * module and connections as the person left them, retaining its environment.
 * Setting values are never part of it; they go with the new attempt's
 * confirming answer.
 */
export function replanRequest(
  plan: GitInstallPlan,
  answers: RetainedAnswers,
): CreateGitInstallAttemptRequest {
  const base = attemptCreateRequest({
    url: plan.source.url,
    ref: answers.ref === "HEAD" ? "" : answers.ref,
    sourcePath: plan.source.path,
    modulePath: answers.modulePath ?? plan.options.modulePath ?? "",
    name: answers.name,
    environment: plan.capsule.environment,
    ...(plan.source.authConnectionId
      ? { authConnectionId: plan.source.authConnectionId }
      : {}),
  });
  return answers.providerBindings.length > 0 || answers.interfaceLinks !== undefined
    ? {
        ...base,
        options: {
          ...base.options,
          ...(answers.providerBindings.length > 0 ? { providerBindings: [...answers.providerBindings] } : {}),
          ...(answers.interfaceLinks !== undefined ? { interfaceLinks: [...answers.interfaceLinks] } : {}),
        },
      }
    : base;
}

// --- Following the coordinator -----------------------------------------------------

/**
 * Whether the page may send the reconcile command now: the coordinator is
 * working on its own (`wait`), or a step could not be confirmed and the
 * contract says to call reconcile again (`retry` without `restart`).
 */
export function canAdvance(response: GitInstallPlanResponse): boolean {
  if (response.invalidated) return false;
  const action = response.userAction;
  return action.kind === "wait" || (action.kind === "retry" && !action.restart);
}

/**
 * What counts as progress while following the coordinator (shared with the
 * app page's reconcile loop). The generation is left out on purpose: every
 * successful reconcile claim bumps it, so it changes even while the
 * coordinator only waits on a sync or Plan Run.
 */
export { gitPlanProgressSignature as progressSignature } from "../../lib/git-plan-progress.ts";

// --- The view -------------------------------------------------------------------

export type InstallStage =
  /** Nothing started; opening the page created nothing. */
  | "candidate"
  /** The attempt the URL names is being read; nothing can start meanwhile. */
  | "loading"
  /** The starting request is in flight. */
  | "starting"
  /** The coordinator works on its own (reading, planning) and this page follows it. */
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

/** The stages the one install screen shows (everything else is a problem card). */
export const INSTALL_SCREEN_STAGES: ReadonlySet<InstallStage> = new Set([
  "starting",
  "reading",
  "paused",
  "choose_module",
  "provide_inputs",
  "review",
]);

/**
 * Phases after the sheet was confirmed: a Plan was asked for (or failed).
 * An edit made in one of them no longer reaches that Plan.
 */
const PAST_INPUT_PHASES: ReadonlySet<GitInstallPlan["phase"]> = new Set([
  "creating_capsule",
  "planning",
  "reviewable",
  "failed",
]);

/** The attempt moved past its sheet: a Plan was asked for from it. */
export function attemptPastInputs(phase: GitInstallPlan["phase"] | undefined): boolean {
  return phase !== undefined && PAST_INPUT_PHASES.has(phase);
}

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

/**
 * Why 「許可してインストール」 cannot be pressed yet, said beside it. Absent
 * once the Plan is ready (the review then owns the button) or on a problem.
 */
export type ApplyBlock =
  /** The attempt is starting or the repository is being read. */
  | "reading"
  /** Following stopped; Continue picks it up. */
  | "paused"
  /** The repository has several apps; one must be chosen. */
  | "module"
  /** A provider still has no connection. */
  | "connections"
  /** An app link still needs a provider or an explicit later answer. */
  | "interfaces"
  /** A required setting is empty. */
  | "settings"
  /** A setting or the app name is not valid. */
  | "invalid"
  /** The Plan is being made (or about to be). */
  | "checking"
  /** A field is being typed in; it counts once it is left. */
  | "editing"
  /** Something changed after the Plan: the install is prepared again. */
  | "replanning"
  /** Making the Plan failed; the person fixes something or tries again. */
  | "failed";

/** The inline progress line of the install screen. */
export type InstallProgress =
  | "reading"
  | "analyzing"
  | "planning"
  | "replanning"
  | "paused"
  /** Preparing again did not go through; Continue tries it again. */
  | "replanPaused"
  /** Making the Plan failed; the reason, and Try again. */
  | "failed";

export interface InstallLocalState {
  /** The starting request is in flight and no attempt exists yet. */
  readonly starting?: boolean;
  /** This page view is advancing the coordinator. */
  readonly driving?: boolean;
  /** A starting, confirming, discarding or restarting request is in flight. */
  readonly mutating?: boolean;
  /**
   * A sheet answer (a connection, the name, a module) is in flight. A
   * confirmation waits for it rather than failing.
   */
  readonly answering?: boolean;
  /** The URL names an attempt that is still being read. */
  readonly loading?: boolean;
  /** The attempt named by the URL could not be read. */
  readonly loadFailed?: boolean;
  readonly drafts?: VariableDrafts;
  /** The name typed in the sheet, when it differs from the attempt's. */
  readonly name?: string;
  /**
   * The person acted in this page view (Install, Continue or an edit), so a
   * complete sheet may be confirmed on its own. A reopened attempt is only
   * read until then.
   */
  readonly armed?: boolean;
  /** The confirming answer is in flight or about to be sent. */
  readonly confirming?: boolean;
  /** Something changed after the Plan was asked for; that Plan is out of date. */
  readonly outdated?: boolean;
  /** The install is being prepared again after such a change. */
  readonly replanning?: boolean;
  /** Preparing again failed and waits for Continue. */
  readonly replanStalled?: boolean;
  /** A field (name, version or a typed setting) is being typed in. */
  readonly editing?: boolean;
  /** The app name typed is not one the API accepts. */
  readonly nameInvalid?: boolean;
  /** The page still holds the person's answers (the sheet they saw). */
  readonly answersKept?: boolean;
}

export interface InstallView {
  readonly stage: InstallStage;
  readonly primary: InstallPrimary;
  /** True while the primary action cannot be pressed yet. */
  readonly primaryBlocked: boolean;
  /** "Stop installing" is offered (it is refused while a request is in flight). */
  readonly canDiscard: boolean;
  readonly missingConnections: readonly GitInstallPlanConnectionRequirement[];
  readonly missingInterfaces: readonly GitInstallPlanInterfaceRequirement[];
  readonly missingVariables: readonly string[];
  readonly invalidVariables: readonly string[];
  /** The name is taken or not a valid app name. */
  readonly nameProblem?: "conflict" | "invalid";
  readonly retryCode?: string;
  readonly invalidated?: GitInstallPlanInvalidation;
  /** Why 「許可してインストール」 waits; absent when the review owns it. */
  readonly applyBlock?: ApplyBlock;
  /** What the install screen says is under way. */
  readonly progress?: InstallProgress;
  /** The sheet is complete and may be confirmed (on its own, once armed). */
  readonly readyToConfirm: boolean;
}

const NOTHING: Pick<
  InstallView,
  "missingConnections" | "missingInterfaces" | "missingVariables" | "invalidVariables" | "readyToConfirm"
> = { missingConnections: [], missingInterfaces: [], missingVariables: [], invalidVariables: [], readyToConfirm: false };

function workingProgress(phase: GitInstallPlan["phase"]): InstallProgress {
  switch (phase) {
    case "compiling_install":
    case "analyzing_compatibility":
      return "analyzing";
    case "awaiting_input":
    case "creating_capsule":
    case "planning":
    case "reviewable":
      return "planning";
    default:
      return "reading";
  }
}

/** The stage, its primary action and what the sheet still needs. */
function deriveStage(
  response: GitInstallPlanResponse | undefined,
  local: InstallLocalState,
): Omit<InstallView, "applyBlock" | "progress"> {
  const mutating = local.mutating === true;
  const busy = mutating || local.answering === true;
  if (!response) {
    if (local.starting) {
      return { ...NOTHING, stage: "starting", primary: "none", primaryBlocked: true, canDiscard: false };
    }
    if (local.loadFailed) {
      return { ...NOTHING, stage: "unavailable", primary: "reload", primaryBlocked: false, canDiscard: false };
    }
    if (local.loading) {
      // A second attempt must never start while the URL's own one loads.
      return { ...NOTHING, stage: "loading", primary: "none", primaryBlocked: true, canDiscard: false };
    }
    return { ...NOTHING, stage: "candidate", primary: "install", primaryBlocked: busy, canDiscard: false };
  }
  const discardable = response.installPlan.phase !== "discarded" && !busy;
  if (response.invalidated) {
    return {
      ...NOTHING,
      stage: "invalidated",
      primary: "restart",
      primaryBlocked: busy,
      canDiscard: discardable,
      invalidated: response.invalidated,
    };
  }
  const action = response.userAction;
  switch (action.kind) {
    case "wait":
      return local.driving
        ? { ...NOTHING, stage: "reading", primary: "none", primaryBlocked: true, canDiscard: discardable }
        : { ...NOTHING, stage: "paused", primary: "continue", primaryBlocked: busy, canDiscard: discardable };
    case "choose_module":
      return {
        ...NOTHING,
        stage: "choose_module",
        primary: "choose_module",
        primaryBlocked: busy || action.modules.length === 0,
        canDiscard: discardable,
      };
    case "provide_inputs": {
      const resubmitting = awaitingResubmission(action);
      const missing = resubmitting ? [] : missingConnections(action.connections);
      const missingLinks = resubmitting ? [] : missingInterfaces(action.interfaces);
      const linksIncomplete = missingLinks.length > 0 || (!resubmitting && action.missing.includes("interfaces"));
      const values = continueVariables(action, local.drafts ?? {});
      const typed = resubmitting ? undefined : local.name?.trim();
      const nameProblem = typed !== undefined && typed !== action.name.current
        ? (appNameValue(typed) ? undefined : "invalid")
        : action.name.conflict && !resubmitting
          ? "conflict"
          : undefined;
      const complete = missing.length === 0 && !linksIncomplete && values.ok && nameProblem === undefined;
      return {
        stage: "provide_inputs",
        primary: missing.length > 0 ? "connect" : "review",
        primaryBlocked: mutating || (missing.length === 0 && !complete),
        canDiscard: discardable,
        missingConnections: missing,
        missingInterfaces: missingLinks,
        missingVariables: values.ok ? [] : values.missing,
        invalidVariables: values.ok ? [] : values.invalid,
        ...(nameProblem ? { nameProblem } : {}),
        readyToConfirm: complete,
      };
    }
    case "review_run":
      return { ...NOTHING, stage: "review", primary: "none", primaryBlocked: true, canDiscard: discardable };
    case "retry":
      if (action.restart) {
        return { ...NOTHING, stage: "failed", primary: "restart", primaryBlocked: busy, canDiscard: discardable, retryCode: action.code };
      }
      // Trying again is one more reconcile; while this page retries on its
      // own it reads as reading.
      return local.driving
        ? { ...NOTHING, stage: "reading", primary: "none", primaryBlocked: true, canDiscard: discardable }
        : { ...NOTHING, stage: "retry", primary: "retry", primaryBlocked: busy, canDiscard: discardable, retryCode: action.code };
    case "none":
      return response.installPlan.phase === "discarded"
        ? { ...NOTHING, stage: "discarded", primary: "reinstall", primaryBlocked: false, canDiscard: false }
        : { ...NOTHING, stage: "unavailable", primary: "reload", primaryBlocked: false, canDiscard: false };
  }
}

/** What the page shows for one attempt answer and the page's own state. */
export function deriveInstallView(
  response: GitInstallPlanResponse | undefined,
  local: InstallLocalState = {},
): InstallView {
  const view = deriveStage(response, local);
  // A Plan that failed after the sheet stays on the screen with the
  // person's answers: they fix something or try again.
  const failedWithAnswers = view.stage === "failed" && local.answersKept === true;
  if (!INSTALL_SCREEN_STAGES.has(view.stage) && !failedWithAnswers) return view;
  if (local.outdated) {
    // The shown Plan no longer matches the screen: never applicable, and
    // prepared again only from valid, finished input.
    if (local.nameInvalid) return { ...view, applyBlock: "invalid" };
    if (local.editing) return { ...view, applyBlock: "editing" };
    if (local.replanStalled) return { ...view, applyBlock: "paused", progress: "replanPaused" };
    return { ...view, applyBlock: "replanning", progress: "replanning" };
  }
  if (local.replanStalled) return { ...view, applyBlock: "paused", progress: "replanPaused" };
  // The attempt that replaces it reads the repository and plans as one
  // step until its new Plan is ready or it needs the person again.
  if (
    local.replanning === true &&
    view.stage !== "review" && view.stage !== "choose_module" && !failedWithAnswers &&
    !(view.stage === "provide_inputs" && !view.readyToConfirm)
  ) {
    return { ...view, applyBlock: "replanning", progress: "replanning" };
  }
  if (failedWithAnswers) return { ...view, applyBlock: "failed", progress: "failed" };
  if (local.editing && (view.stage === "review" || view.stage === "provide_inputs")) {
    return { ...view, applyBlock: "editing" };
  }
  const phase = response?.installPlan.phase;
  switch (view.stage) {
    case "starting":
      return { ...view, applyBlock: "reading", progress: "reading" };
    case "reading": {
      const progress = phase ? workingProgress(phase) : "reading";
      return { ...view, applyBlock: progress === "planning" ? "checking" : "reading", progress };
    }
    case "paused":
      return { ...view, applyBlock: "paused", progress: "paused" };
    case "choose_module":
      return { ...view, applyBlock: "module" };
    case "provide_inputs": {
      if (view.missingConnections.length > 0) return { ...view, applyBlock: "connections" };
      if (view.missingInterfaces.length > 0 || (response?.userAction.kind === "provide_inputs" && !awaitingResubmission(response.userAction) && response.userAction.missing.includes("interfaces"))) return { ...view, applyBlock: "interfaces" };
      if (view.missingVariables.length > 0) return { ...view, applyBlock: "settings" };
      if (view.invalidVariables.length > 0 || view.nameProblem) return { ...view, applyBlock: "invalid" };
      // Complete: a reopened attempt waits for the person; otherwise the
      // Plan is being asked for.
      if (!local.armed && !local.confirming) return { ...view, applyBlock: "paused", progress: "paused" };
      return { ...view, applyBlock: "checking", progress: "planning" };
    }
    default:
      return view;
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
