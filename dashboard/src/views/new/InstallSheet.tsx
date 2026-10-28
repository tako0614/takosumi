/**
 * The one install screen (TASK-0115): everything between 「インストール」 and
 * 「許可してインストール」, all visible at once.
 *
 * - The app's name and version, and a progress line while the repository is
 *   read or the Plan is made.
 * - A module choice inline when the repository has several apps.
 * - One row per provider (chosen on its own when there is one candidate,
 *   connectable right here), and the settings (required, then optional;
 *   write-only ones never shown back).
 * - What the app will create and its cost: the definition's preview first,
 *   the Plan's exact list once it is ready.
 * - 「許可してインストール」 from the start, disabled with the reason until the
 *   Plan is ready, and 「インストールをやめる」 throughout.
 *
 * Nothing here asks for a "next" click: the attempt controller confirms a
 * complete sheet on its own and prepares the install again after a change.
 */
import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Suspense, Switch } from "solid-js";
import { ExternalLink, PlugZap } from "lucide-solid";
import type {
  GitInstallPlanConnectionRequirement,
  GitInstallPlanUserAction,
  GitInstallPlanVariablePresentation,
} from "takosumi-contract";
import {
  Badge,
  Button,
  FormField,
  Input,
  Select,
  Spinner,
  Textarea,
} from "../../components/ui/index.ts";
import { locale, t, type MessageKey } from "../../i18n/index.ts";
import { getCapsuleApp, testConnection } from "../../lib/control-api.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { providerConnectionStatusLabel } from "../../lib/labels.ts";
import { readableProviderSourceLabel } from "../../lib/provider-labels.ts";
import ConnectionCreateForm from "../workspace/connections/ConnectionCreateForm.tsx";
import { PlannedResources } from "../app/PlannedResources.tsx";
import InstallExecution from "./InstallExecution.tsx";
import {
  appNameValue,
  attemptPastInputs,
  attemptProblemKey,
  awaitingResubmission,
  connectionKey,
  continueVariables,
  selectedCandidate,
  sheetVariables,
  variableInitialText,
  type ApplyBlock,
  type InstallProgress,
} from "./install-attempt.ts";
import type { InstallAttempt } from "./use-install-attempt.ts";

type ChooseModule = Extract<GitInstallPlanUserAction, { kind: "choose_module" }>;
type ReviewRun = Extract<GitInstallPlanUserAction, { kind: "review_run" }>;

/** The working progress lines (a spinner and words). */
type WorkingProgress = Exclude<InstallProgress, "paused" | "replanPaused" | "failed">;

const PROGRESS_TEXT: Readonly<Record<WorkingProgress, MessageKey>> = {
  reading: "installStore.progress.reading",
  analyzing: "installStore.progress.analyzing",
  planning: "installStore.progress.planning",
  replanning: "installStore.progress.replanning",
};

/** The id that ties 「許可してインストール」 to why it waits. */
const APPLY_REASON_ID = "iv-apply-reason";

const APPLY_WAIT_TEXT: Readonly<Record<ApplyBlock, MessageKey>> = {
  reading: "installStore.applyWait.reading",
  paused: "installStore.applyWait.paused",
  module: "installStore.applyWait.module",
  connections: "installStore.applyWait.connections",
  settings: "installStore.applyWait.settings",
  invalid: "installStore.applyWait.invalid",
  checking: "installStore.applyWait.checking",
  editing: "installStore.applyWait.editing",
  replanning: "installStore.applyWait.replanning",
  failed: "installStore.applyWait.failed",
};

function localizedText(
  value: { readonly ja?: string; readonly en?: string } | undefined,
  fallback: string,
): string {
  const text = value?.[locale()]?.trim() || value?.ja?.trim() || value?.en?.trim();
  return text || fallback;
}

/** The screen's own error: the request that failed, or the attempt's reason. */
function ScreenError(props: { readonly attempt: InstallAttempt }) {
  const message = () => {
    const local = props.attempt.error();
    if (local) return local;
    // A failed Plan's reason is the progress line's own.
    if (props.attempt.view().stage === "failed") return undefined;
    const diagnostic = props.attempt.response()?.installPlan.diagnostic;
    return diagnostic ? t(attemptProblemKey(diagnostic.code)) : undefined;
  };
  return (
    <Show when={message()}>
      {(text) => <div class="iv-error" role="alert">{text()}</div>}
    </Show>
  );
}

function StopButton(props: { readonly attempt: InstallAttempt }) {
  return (
    <Button
      type="button"
      variant="ghost"
      busy={props.attempt.mutating() === "discard"}
      disabled={!props.attempt.view().canDiscard}
      onClick={() => void props.attempt.discard()}
    >
      {t("installStore.discard")}
    </Button>
  );
}

/**
 * What is under way, in one line. A paused install, a preparation that did
 * not go through and a Plan that failed continue from here.
 */
function ProgressLine(props: { readonly attempt: InstallAttempt }) {
  const view = () => props.attempt.view();
  const stoppedText = (kind: InstallProgress) => {
    switch (kind) {
      case "replanPaused":
        return t("installStore.progress.replanPaused");
      case "failed":
        return t(attemptProblemKey(view().retryCode));
      default:
        return view().stage === "provide_inputs"
          ? t("installStore.progress.pausedReady")
          : t("installStore.progress.paused");
    }
  };
  const working = (kind: InstallProgress): kind is WorkingProgress =>
    kind !== "paused" && kind !== "replanPaused" && kind !== "failed";
  return (
    <Show when={view().progress}>
      {(kind) => (
        <div
          class="iv-progress"
          role={kind() === "failed" ? "alert" : "status"}
          aria-live="polite"
          data-testid="install-progress"
          data-progress={kind()}
        >
          <Show when={working(kind()) ? kind() as WorkingProgress : undefined} fallback={<span>{stoppedText(kind())}</span>}>
            {(progress) => (
              <>
                <Spinner size={16} />
                <span>{t(PROGRESS_TEXT[progress()])}</span>
              </>
            )}
          </Show>
          <Show when={!working(kind())}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={props.attempt.mutating() !== undefined}
              onClick={() => props.attempt.resume()}
            >
              {kind() === "failed" ? t("installStore.problem.retry") : t("installStore.continue")}
            </Button>
          </Show>
          {/* A failed Plan's reason and logs are on its run's page. */}
          <Show when={kind() === "failed" ? props.attempt.response()?.installPlan.planRunId : undefined}>
            {(runId) => (
              <Button variant="ghost" size="sm" href={`/runs/${encodeURIComponent(runId())}`} icon={<ExternalLink size={16} />}>
                {t("installStore.runDetails")}
              </Button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

/** The repository has several apps: one is chosen right here. */
function ModuleChoice(props: { readonly attempt: InstallAttempt; readonly action: ChooseModule }) {
  const requested = () =>
    props.action.modules.some((module) => module.path === props.action.requested) ? props.action.requested! : "";
  const label = (module: ChooseModule["modules"][number]) =>
    t("installStore.moduleOption", {
      path: module.path,
      providers: module.providers.length > 0
        ? [...new Set(module.providers.map(readableProviderSourceLabel))].join(", ")
        : t("installStore.moduleNoProviders"),
    });
  return (
    <section class="iv-sheet-block" data-testid="install-module-chooser" aria-labelledby="iv-module-title">
      <h3 id="iv-module-title">{t("installStore.moduleTitle")}</h3>
      <p class="iv-muted">{t("installStore.moduleHint")}</p>
      <FormField label={t("installStore.moduleChoose")} required>
        <Select
          value={requested()}
          disabled={props.attempt.mutating() !== undefined}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) void props.attempt.chooseModule(value);
          }}
        >
          <option value="">{t("installStore.moduleChoose")}</option>
          <For each={props.action.modules}>
            {(module) => (
              <option value={module.path} selected={module.path === requested()}>
                {label(module)}
              </option>
            )}
          </For>
        </Select>
      </FormField>
    </section>
  );
}

/**
 * Before the Plan: the definition's preview of what the app creates, the
 * cost as not known yet, and 「許可してインストール」 disabled with its reason.
 */
function PlanPreview(props: { readonly attempt: InstallAttempt }) {
  const block = () => props.attempt.view().applyBlock;
  return (
    <section class="iv-execution" data-testid="install-plan-preview" data-apply-block={block() ?? ""} aria-labelledby="iv-preview-title">
      <div class="iv-review-head">
        <div>
          <h3 id="iv-preview-title">{t("installStore.reviewTitle")}</h3>
          <p>{t("installStore.reviewHint")}</p>
        </div>
      </div>
      <section class="iv-sheet-block" data-testid="install-planned-resources" aria-labelledby="iv-planned-title">
        <h4 id="iv-planned-title">{t("installStore.plannedTitle")}</h4>
        <Show when={props.attempt.sheet()} fallback={<p class="iv-muted">{t("installStore.plannedPending")}</p>}>
          {(sheet) => (
            <>
              <PlannedResources resources={sheet().resources} />
              <p class="iv-muted">{t("installStore.plannedHint")}</p>
            </>
          )}
        </Show>
      </section>
      <section class="iv-sheet-block" data-testid="install-cost-pending" aria-labelledby="iv-cost-pending-title">
        <h4 id="iv-cost-pending-title">{t("installStore.costTitle")}</h4>
        <p class="iv-muted">{t("installStore.costPending")}</p>
      </section>
      <Show when={block()}>
        {(reason) => (
          <p class="iv-apply-reason" id={APPLY_REASON_ID} data-testid="install-apply-reason">
            {t(APPLY_WAIT_TEXT[reason()])}
          </p>
        )}
      </Show>
      <div class="iv-action-row">
        {/* Focusable (aria-disabled, not disabled) so its reason is read
            out; it never does anything before the Plan is ready. */}
        <Button
          type="button"
          variant="primary"
          size="lg"
          aria-disabled="true"
          aria-describedby={block() ? APPLY_REASON_ID : undefined}
          onClick={(event) => event.preventDefault()}
        >
          {t("installStore.allowInstall")}
        </Button>
        <StopButton attempt={props.attempt} />
      </div>
    </section>
  );
}

/**
 * The Plan is ready: what the app creates, its cost, policy reasons and the
 * one apply click. A reopened review first asks the app where it stands
 * (GET /capsules/:id/app): an apply already running is followed instead of
 * offering the click again, and an app already installed is done.
 */
function PlanReview(props: {
  readonly attempt: InstallAttempt;
  readonly action: ReviewRun;
  readonly onDone: (capsuleId: string) => void;
}) {
  const [app] = createResource(
    () => props.action.capsuleId,
    (capsuleId) => getCapsuleApp(capsuleId).catch(() => undefined),
  );
  createEffect(() => {
    if (app()?.applied) props.onDone(props.action.capsuleId);
  });
  const entryRunId = () => {
    const view = app();
    const run = view?.progress.run ?? view?.latestRun;
    return run && (run.type === "apply" || run.type === "plan") && run.id !== props.action.planRunId
      ? run.id
      : undefined;
  };
  const block = () => props.attempt.view().applyBlock;
  return (
    <section class="iv-plan-review" data-testid="install-review" data-apply-block={block() ?? ""}>
      <Show
        when={!app.loading}
        fallback={<div class="iv-status" role="status"><Spinner size={18} /><span>{t("common.loading")}</span></div>}
      >
        <Show when={!app()?.applied}>
          <InstallExecution
            showPolicyReasons
            planRunId={props.action.planRunId}
            initialRunId={entryRunId()}
            capsuleId={props.action.capsuleId}
            blockedReason={block() ? t(APPLY_WAIT_TEXT[block()!]) : undefined}
            onApplyStarted={() => props.attempt.lockAnswers()}
            onDone={() => props.onDone(props.action.capsuleId)}
            restartLabel={t("installStore.problem.restart")}
            onRestart={async () => {
              if (!(await props.attempt.restart())) {
                throw new Error(props.attempt.error() ?? t("installStore.error.unavailable"));
              }
            }}
            onDiscard={async () => {
              await props.attempt.discard();
            }}
          />
        </Show>
      </Show>
    </section>
  );
}

export function InstallScreen(props: {
  readonly attempt: InstallAttempt;
  readonly workspaceId: string;
  /** The install started from a Store listing (an empty version means its newest release). */
  readonly fromStore: boolean;
  readonly onDone: (capsuleId: string) => void;
}) {
  const attempt = () => props.attempt;
  const view = () => props.attempt.view();
  const plan = () => props.attempt.response()?.installPlan;
  const sheet = () => props.attempt.sheet();
  const resubmitting = () => {
    const current = sheet();
    return Boolean(current && props.attempt.response()?.userAction.kind === "provide_inputs" && awaitingResubmission(current));
  };
  const busy = () => props.attempt.mutating() !== undefined;
  /** An Apply started: the answers on this screen are what it applies. */
  const locked = () => props.attempt.locked();
  /**
   * A connection can be answered while the sheet is asked for, or changed
   * once the Plan was asked for (preparing the install again); not while a
   * new attempt is still reading the repository.
   */
  const connectionsEditable = () =>
    !locked() && (view().stage === "provide_inputs" || attemptPastInputs(plan()?.phase));
  // The provider row whose connection form is open inside the screen.
  const [connecting, setConnecting] = createSignal<string>();
  const [rowErrors, setRowErrors] = createSignal<Readonly<Record<string, string>>>({});

  const formId = (requirement: GitInstallPlanConnectionRequirement) =>
    `install-connect-${connectionKey(requirement).replace(/[^A-Za-z0-9_-]/gu, "-")}`;

  const setRowError = (requirement: GitInstallPlanConnectionRequirement, message?: string) =>
    setRowErrors((current) => {
      const next = { ...current };
      if (message) next[connectionKey(requirement)] = message;
      else delete next[connectionKey(requirement)];
      return next;
    });

  /** Closing a row's form returns focus that fell to the page to its toggle. */
  const focusToggleIfLost = (requirement: GitInstallPlanConnectionRequirement) =>
    queueMicrotask(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      document
        .querySelector<HTMLElement>(`[aria-controls="${formId(requirement)}"]`)
        ?.focus({ preventScroll: true });
    });

  const toggleConnect = (requirement: GitInstallPlanConnectionRequirement) => {
    const key = connectionKey(requirement);
    if (connecting() === key) {
      setConnecting(undefined);
      focusToggleIfLost(requirement);
      return;
    }
    setConnecting(key);
    queueMicrotask(() => {
      if (connecting() !== key) return;
      document.getElementById(formId(requirement))?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  };

  /** A connection saved from the screen is chosen for its row once offered there. */
  const adopt = async (requirement: GitInstallPlanConnectionRequirement, connectionId: string) => {
    const result = await attempt().adoptConnection(requirement, connectionId);
    if (result === "selected") {
      setRowError(requirement);
      if (connecting() === connectionKey(requirement)) {
        setConnecting(undefined);
        focusToggleIfLost(requirement);
      }
    }
    return result;
  };

  // Typed credentials are tested once after saving, as on the connections
  // page; OAuth connections arrive verified and skip the test.
  const verify = async (requirement: GitInstallPlanConnectionRequirement, connectionId: string) => {
    try {
      const result = (await testConnection(connectionId)) as { readonly status?: string } | undefined;
      if (result?.status && result.status !== "verified") {
        setRowError(requirement, t("conn.test.notReady", {
          status: providerConnectionStatusLabel(result.status),
        }));
        return;
      }
    } catch (cause) {
      setRowError(requirement, friendlyError(cause, t).message);
      return;
    }
    if ((await adopt(requirement, connectionId)) === "not_offered") {
      setRowError(requirement, t("installStore.connectionNotAllowed"));
    }
  };

  // Rows and fields are keyed by identity strings, so a new answer from the
  // coordinator keeps their DOM (and a half-filled connection form) in place.
  const sameKeys = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((key, index) => key === right[index]);
  const rows = () => props.attempt.connectionRows();
  const rowKeys = createMemo(() => rows().map(connectionKey), [], { equals: sameKeys });
  const requirementFor = (key: string) => rows().find((requirement) => connectionKey(requirement) === key);
  const missingRows = () => rows().filter((requirement) => !selectedCandidate(requirement)).length;

  const ConnectionRow = (rowProps: { readonly requirement: GitInstallPlanConnectionRequirement }) => {
    const requirement = () => rowProps.requirement;
    const selected = () => selectedCandidate(requirement());
    const open = () => connecting() === connectionKey(requirement());
    const choosable = () =>
      !resubmitting() &&
      (requirement().candidates.length > 1 || (requirement().candidates.length === 1 && !selected()));
    return (
      <article
        class="iv-connection-row"
        data-testid="install-required-connection"
        data-provider-source={requirement().provider}
        data-module-local-name={requirement().moduleLocalName}
        data-child-alias={requirement().childAlias ?? ""}
        data-connection-state={selected() ? "connected" : "missing"}
      >
        <div class="iv-connection-head">
          <strong>
            {readableProviderSourceLabel(requirement().provider)}
            {requirement().childAlias ? ` (${requirement().childAlias})` : ""}
          </strong>
          <Badge tone={selected() ? "ok" : "warn"}>
            {selected() ? `✓ ${t("installStore.connectionReady")}` : t("installStore.connectionMissing")}
          </Badge>
        </div>
        <Show
          when={choosable()}
          fallback={
            <Show when={selected()}>
              {(connection) => <p class="iv-connection-name">{connection().displayName}</p>}
            </Show>
          }
        >
          <FormField label={t("installStore.destination")} required>
            <Select
              value={selected()?.id ?? ""}
              disabled={busy() || !connectionsEditable()}
              onChange={async (event) => {
                const element = event.currentTarget;
                // A refused choice must not stay shown: return to the
                // current selection.
                if (!(await attempt().chooseConnection(requirement(), element.value))) {
                  element.value = selectedCandidate(requirement())?.id ?? "";
                }
              }}
            >
              <option value="">{t("installStore.chooseConnection")}</option>
              <For each={requirement().candidates}>
                {(candidate) => (
                  <option value={candidate.id} selected={candidate.id === selected()?.id}>
                    {candidate.displayName}
                  </option>
                )}
              </For>
            </Select>
          </FormField>
        </Show>
        <Show when={!resubmitting() && connectionsEditable()}>
          <div class="iv-action-row">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<PlugZap size={16} />}
              aria-expanded={open()}
              aria-controls={formId(requirement())}
              onClick={() => toggleConnect(requirement())}
            >
              {open()
                ? t("installStore.closePanel")
                : requirement().candidates.length === 0
                  ? t("installStore.connect")
                  : t("installStore.addConnection")}
            </Button>
          </div>
        </Show>
        <Show when={rowErrors()[connectionKey(requirement())]}>
          {(message) => <p class="iv-muted" role="alert">{message()}</p>}
        </Show>
        <Show when={open()}>
          <div class="iv-inline-connect" id={formId(requirement())}>
            {/* The form reads the setup catalog; suspend here, not the page. */}
            <Suspense fallback={<div role="status"><Spinner size={18} />{t("common.loading")}</div>}>
              <ConnectionCreateForm
                workspaceId={props.workspaceId}
                initialProviderSource={requirement().provider}
                restrictToInitialProvider
                onCreated={async (connection) => {
                  // A saved OAuth connection is already verified; a typed one
                  // is tested first (verifyConnection) and adopted there.
                  if (connection.status === "verified") {
                    if ((await adopt(requirement(), connection.id)) === "not_offered") {
                      setRowError(requirement(), t("installStore.connectionNotAllowed"));
                    }
                  }
                }}
                verifyConnection={(connectionId) => verify(requirement(), connectionId)}
              />
            </Suspense>
          </div>
        </Show>
      </article>
    );
  };

  // Settings are checked against the sheet the person sees, whatever the
  // coordinator is doing now.
  const settingsCheck = createMemo(() => {
    const current = sheet();
    return current ? continueVariables(current, props.attempt.drafts()) : undefined;
  });

  const draftText = (variable: GitInstallPlanVariablePresentation) => {
    const draft = attempt().drafts()[variable.name];
    return draft?.touched || variable.sensitive ? (draft?.value ?? "") : variableInitialText(variable);
  };

  const fieldHint = (variable: GitInstallPlanVariablePresentation) => {
    const description = localizedText(variable.description, "");
    const note = variable.sensitive
      ? variable.type === "json"
        ? `${t("installStore.secretJsonHint")} ${t("installStore.secretHint")}`
        : t("installStore.secretHint")
      : variable.derivedDefault
        ? t("installStore.derivedHint")
        : "";
    return [description, note].filter(Boolean).join(" ") || undefined;
  };

  const VariableField = (fieldProps: { readonly variable: GitInstallPlanVariablePresentation }) => {
    const variable = () => fieldProps.variable;
    const invalid = () => {
      const check = settingsCheck();
      return Boolean(check && !check.ok && check.invalid.includes(variable().name));
    };
    // A choice counts at once; typed text counts when its field is left.
    const choose = (value: string) => attempt().setDraft(variable().name, value);
    const type = (value: string) => attempt().setDraft(variable().name, value, { typing: true });
    const leave = () => attempt().commitDraft(variable().name);
    const leaveOnEnter = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        leave();
      }
    };
    return (
      <FormField
        label={localizedText(variable().label, variable().name)}
        hint={fieldHint(variable())}
        error={invalid() ? t("installStore.settingInvalid") : undefined}
        required={variable().required}
      >
        <Switch
          fallback={
            <Input
              type={variable().sensitive ? "password" : variable().type === "number" ? "number" : "text"}
              inputmode={variable().sensitive && variable().type === "number" ? "decimal" : undefined}
              autocomplete={variable().sensitive ? "new-password" : "off"}
              value={draftText(variable())}
              placeholder={variable().sensitive ? undefined : variable().placeholder}
              spellcheck={false}
              disabled={locked()}
              data-variable-name={variable().name}
              onInput={(event) => type(event.currentTarget.value)}
              onBlur={leave}
              onKeyDown={leaveOnEnter}
            />
          }
        >
          {/* A yes/no setting is a choice even when it is write-only: the
              value lives only in this page's memory either way. */}
          <Match when={variable().type === "boolean"}>
            <Select
              value={draftText(variable())}
              disabled={locked()}
              data-variable-name={variable().name}
              onChange={(event) => choose(event.currentTarget.value)}
            >
              <option value="">{t("installStore.selectValue")}</option>
              <option value="true">{t("installStore.yes")}</option>
              <option value="false">{t("installStore.no")}</option>
            </Select>
          </Match>
          {/* A JSON value gets lines to edit. A write-only one stays a
              password field instead (one line: JSON needs no line breaks),
              so no browser ever shows it as typed. */}
          <Match when={variable().type === "json" && !variable().sensitive}>
            <Textarea
              value={draftText(variable())}
              spellcheck={false}
              autocomplete="off"
              disabled={locked()}
              data-variable-name={variable().name}
              onInput={(event) => type(event.currentTarget.value)}
              onBlur={leave}
            />
          </Match>
        </Switch>
      </FormField>
    );
  };

  const variables = () => {
    const current = sheet();
    return current ? sheetVariables(current) : [];
  };
  const requiredNames = createMemo(
    () => variables().filter((variable) => variable.required).map((variable) => variable.name),
    [],
    { equals: sameKeys },
  );
  const optionalNames = createMemo(
    () => variables().filter((variable) => !variable.required).map((variable) => variable.name),
    [],
    { equals: sameKeys },
  );
  const variableFor = (name: string) => variables().find((variable) => variable.name === name);

  // --- name and version ---------------------------------------------------------
  const currentName = () => sheet()?.name.current ?? plan()?.capsule.name ?? "";
  const nameText = () => attempt().nameDraft() ?? currentName();
  const nameError = () => {
    const typed = attempt().nameDraft()?.trim();
    if (typed !== undefined && typed !== currentName() && !appNameValue(typed)) return t("installStore.invalidName");
    return view().nameProblem === "conflict" ? t("installStore.nameTaken") : undefined;
  };
  const proposedName = () => {
    const current = sheet();
    return current && view().stage === "provide_inputs" && current.name.conflict && !resubmitting() &&
        current.name.proposed !== current.name.current && nameText() !== current.name.proposed
      ? current.name.proposed
      : undefined;
  };
  const versionShown = () => {
    const typed = attempt().refDraft();
    if (typed !== undefined) return typed;
    const ref = plan()?.source.ref ?? "";
    const resolved = attempt().resolvedVersion();
    if (resolved && resolved.commit === ref) return resolved.tag;
    return ref === "HEAD" ? "" : ref;
  };
  const versionText = () => attempt().versionDraft() ?? versionShown();

  const reviewAction = () => {
    const action = props.attempt.response()?.userAction;
    return view().stage === "review" && action?.kind === "review_run" ? action : undefined;
  };
  const moduleAction = () => {
    const action = props.attempt.response()?.userAction;
    return view().stage === "choose_module" && action?.kind === "choose_module" ? action : undefined;
  };

  return (
    <section
      class="iv-workbench iv-sheet"
      data-testid="install-configuration"
      data-install-state={view().applyBlock ?? "review"}
      aria-labelledby="iv-sheet-title"
    >
      <div class="iv-section-head">
        <h2 id="iv-sheet-title" data-stage-heading tabindex="-1">{t("installStore.sheetTitle")}</h2>
        <p>{t("installStore.sheetHint")}</p>
      </div>
      <ProgressLine attempt={props.attempt} />
      <ScreenError attempt={props.attempt} />
      <Show when={resubmitting()}>
        <aside class="iv-setup-note" role="status" data-testid="install-resubmit">
          <strong>{t("installStore.resubmitTitle")}</strong>
          <p>{t("installStore.resubmitHint")}</p>
        </aside>
      </Show>

      <section class="iv-sheet-block" aria-labelledby="iv-basics-title" data-testid="install-basics">
        <h3 id="iv-basics-title">{t("installStore.basicsTitle")}</h3>
        <div class="iv-fields">
          <FormField label={t("installStore.name")} hint={t("installStore.nameHint")} error={nameError()} required>
            <Input
              value={nameText()}
              spellcheck={false}
              disabled={!sheet() || resubmitting() || locked()}
              data-testid="install-app-name"
              onInput={(event) => attempt().setNameDraft(event.currentTarget.value)}
              onBlur={() => void attempt().saveName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void attempt().saveName();
                }
              }}
            />
          </FormField>
          <FormField
            label={t("installStore.sourceRef")}
            hint={props.fromStore ? t("installStore.sourceRefStableHint") : t("installStore.sourceRefHint")}
          >
            <Input
              value={versionText()}
              placeholder={props.fromStore ? t("installStore.sourceRefStable") : undefined}
              spellcheck={false}
              disabled={resubmitting() || !plan() || locked()}
              data-testid="install-version"
              onInput={(event) => attempt().setVersionDraft(event.currentTarget.value)}
              onBlur={() => attempt().commitVersion()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  attempt().commitVersion();
                }
              }}
            />
          </FormField>
        </div>
        <Show when={proposedName()}>
          {(proposed) => (
            <div class="iv-action-row iv-name-proposal">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy()}
                onClick={() => {
                  attempt().setNameDraft(proposed());
                  void attempt().saveName();
                }}
              >
                {t("installStore.useProposedName", { name: proposed() })}
              </Button>
            </div>
          )}
        </Show>
      </section>

      <Show when={moduleAction()}>
        {(action) => <ModuleChoice attempt={props.attempt} action={action()} />}
      </Show>

      <Show when={rows().length > 0}>
        <section class="iv-sheet-block" aria-labelledby="iv-connections-title" data-testid="install-connections">
          <h3 id="iv-connections-title">{t("installStore.cloudConnection")}</h3>
          <p class="iv-muted">
            {missingRows() === 0 ? t("installStore.cloudConnected") : t("installStore.providerHint")}
          </p>
          <For each={rowKeys()}>
            {(key) => (
              <Show when={requirementFor(key)}>
                {(requirement) => <ConnectionRow requirement={requirement()} />}
              </Show>
            )}
          </For>
        </section>
      </Show>

      <Show when={variables().length > 0}>
        <section class="iv-sheet-block" aria-labelledby="iv-settings-title" data-testid="install-settings">
          <h3 id="iv-settings-title">{t("installStore.setupTitle")}</h3>
          <Show when={requiredNames().length > 0}>
            <div class="iv-fields">
              <For each={requiredNames()}>
                {(name) => <Show when={variableFor(name)}>{(variable) => <VariableField variable={variable()} />}</Show>}
              </For>
            </div>
          </Show>
          <Show when={optionalNames().length > 0}>
            <div class="iv-optional-settings" data-testid="install-optional-settings">
              <h4>{t("installStore.optionalSettings")}</h4>
              <p class="iv-muted">{t("installStore.optionalSettingsHint")}</p>
              <div class="iv-fields">
                <For each={optionalNames()}>
                  {(name) => <Show when={variableFor(name)}>{(variable) => <VariableField variable={variable()} />}</Show>}
                </For>
              </div>
            </div>
          </Show>
        </section>
      </Show>

      <Show when={reviewAction()} fallback={<PlanPreview attempt={props.attempt} />}>
        {(action) => <PlanReview attempt={props.attempt} action={action()} onDone={props.onDone} />}
      </Show>
    </section>
  );
}
