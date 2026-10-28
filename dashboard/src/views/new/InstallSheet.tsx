/**
 * The install sheet (TASK-0115 Phase 3b): what the app will create in the
 * person's cloud, the connections it needs (connectable right here), its
 * settings and its name — everything the coordinator asks for in one
 * `provide_inputs` answer, or the module choice before it.
 *
 * Every change is an answer to the coordinator. Setting values stay in the
 * attempt controller's memory and are sent only by 「内容を確認」.
 */
import { createMemo, createSignal, For, Match, Show, Suspense, Switch } from "solid-js";
import { PlugZap } from "lucide-solid";
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
import { locale, t } from "../../i18n/index.ts";
import { testConnection } from "../../lib/control-api.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { providerConnectionStatusLabel } from "../../lib/labels.ts";
import { readableProviderSourceLabel } from "../../lib/provider-labels.ts";
import ConnectionCreateForm from "../workspace/connections/ConnectionCreateForm.tsx";
import { PlannedResources } from "../app/PlannedResources.tsx";
import {
  attemptProblemKey,
  awaitingResubmission,
  connectionKey,
  selectedCandidate,
  sheetVariables,
  variableInitialText,
} from "./install-attempt.ts";
import type { InstallAttempt } from "./use-install-attempt.ts";

type ProvideInputs = Extract<GitInstallPlanUserAction, { kind: "provide_inputs" }>;
type ChooseModule = Extract<GitInstallPlanUserAction, { kind: "choose_module" }>;

function localizedText(
  value: { readonly ja?: string; readonly en?: string } | undefined,
  fallback: string,
): string {
  const text = value?.[locale()]?.trim() || value?.ja?.trim() || value?.en?.trim();
  return text || fallback;
}

/** The sheet's own error: the request that failed, or the attempt's reason. */
function SheetError(props: { readonly attempt: InstallAttempt }) {
  const message = () => {
    const local = props.attempt.error();
    if (local) return local;
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

export function ModuleChooser(props: {
  readonly attempt: InstallAttempt;
  readonly action: ChooseModule;
}) {
  const [selected, setSelected] = createSignal(
    props.action.modules.some((module) => module.path === props.action.requested)
      ? props.action.requested!
      : "",
  );
  const label = (module: ChooseModule["modules"][number]) =>
    t("installStore.moduleOption", {
      path: module.path,
      providers: module.providers.length > 0
        ? [...new Set(module.providers.map(readableProviderSourceLabel))].join(", ")
        : t("installStore.moduleNoProviders"),
    });
  return (
    <section class="iv-workbench iv-sheet" data-testid="install-module-chooser" aria-labelledby="iv-module-title">
      <div class="iv-section-head">
        <h2 id="iv-module-title" data-stage-heading tabindex="-1">{t("installStore.moduleTitle")}</h2>
        <p>{t("installStore.moduleHint")}</p>
      </div>
      <SheetError attempt={props.attempt} />
      <form
        class="iv-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected()) void props.attempt.chooseModule(selected());
        }}
      >
        <FormField label={t("installStore.moduleChoose")} required>
          <Select value={selected()} onChange={(event) => setSelected(event.currentTarget.value)}>
            <option value="">{t("installStore.moduleChoose")}</option>
            <For each={props.action.modules}>
              {(module) => (
                <option value={module.path} selected={module.path === selected()}>
                  {label(module)}
                </option>
              )}
            </For>
          </Select>
        </FormField>
        <div class="iv-action-row">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            busy={props.attempt.mutating() === "answer"}
            disabled={!selected() || props.attempt.view().primaryBlocked}
          >
            {t("installStore.moduleConfirm")}
          </Button>
          <StopButton attempt={props.attempt} />
        </div>
      </form>
    </section>
  );
}

export function InstallSheet(props: {
  readonly attempt: InstallAttempt;
  readonly action: ProvideInputs;
  readonly workspaceId: string;
}) {
  const attempt = () => props.attempt;
  const view = () => props.attempt.view();
  const resubmitting = () => awaitingResubmission(props.action);
  // The provider row whose connection form is open inside the sheet.
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

  /** A connection saved from the sheet is chosen for its row once offered there. */
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

  const openFirstMissing = () => {
    const missing = view().missingConnections[0];
    if (missing && connecting() !== connectionKey(missing)) toggleConnect(missing);
  };

  // Rows and fields are keyed by identity strings, so a new answer from the
  // coordinator keeps their DOM (and a half-filled connection form) in place.
  const sameKeys = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((key, index) => key === right[index]);
  const rowKeys = createMemo(() => props.action.connections.map(connectionKey), [], { equals: sameKeys });
  const requirementFor = (key: string) =>
    props.action.connections.find((requirement) => connectionKey(requirement) === key);

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
              disabled={attempt().mutating() !== undefined}
              onChange={async (event) => {
                const element = event.currentTarget;
                // A refused choice must not stay shown: return to the
                // coordinator's own selection.
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
        <Show when={!resubmitting()}>
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

  const draftText = (variable: GitInstallPlanVariablePresentation) => {
    const draft = attempt().drafts()[variable.name];
    return draft?.touched || variable.sensitive ? (draft?.value ?? "") : variableInitialText(variable);
  };

  const fieldHint = (variable: GitInstallPlanVariablePresentation) => {
    const description = localizedText(variable.description, "");
    const note = variable.sensitive
      ? t("installStore.secretHint")
      : variable.derivedDefault
        ? t("installStore.derivedHint")
        : "";
    return [description, note].filter(Boolean).join(" ") || undefined;
  };

  const VariableField = (fieldProps: { readonly variable: GitInstallPlanVariablePresentation }) => {
    const variable = () => fieldProps.variable;
    const invalid = () => view().invalidVariables.includes(variable().name);
    const update = (value: string) => attempt().setDraft(variable().name, value);
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
              data-variable-name={variable().name}
              onInput={(event) => update(event.currentTarget.value)}
            />
          }
        >
          {/* A yes/no setting is a choice even when it is write-only: the
              value lives only in this page's memory either way. */}
          <Match when={variable().type === "boolean"}>
            <Select
              value={draftText(variable())}
              data-variable-name={variable().name}
              onChange={(event) => update(event.currentTarget.value)}
            >
              <option value="">{t("installStore.selectValue")}</option>
              <option value="true">{t("installStore.yes")}</option>
              <option value="false">{t("installStore.no")}</option>
            </Select>
          </Match>
          {/* A JSON value needs lines; a write-only one is masked as typed. */}
          <Match when={variable().type === "json"}>
            <Textarea
              value={draftText(variable())}
              spellcheck={false}
              autocomplete="off"
              classList={{ "iv-secret-text": variable().sensitive }}
              data-variable-name={variable().name}
              onInput={(event) => update(event.currentTarget.value)}
            />
          </Match>
        </Switch>
      </FormField>
    );
  };

  const variables = () => sheetVariables(props.action);
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
  const nameText = () => attempt().nameDraft() ?? props.action.name.current;
  const sheetState = () =>
    view().missingConnections.length > 0 ? "provider-required" : view().primaryBlocked ? "configuring" : "ready";

  return (
    <section
      class="iv-workbench iv-sheet"
      data-testid="install-configuration"
      data-install-state={sheetState()}
      aria-labelledby="iv-sheet-title"
    >
      <div class="iv-section-head">
        <h2 id="iv-sheet-title" data-stage-heading tabindex="-1">{t("installStore.sheetTitle")}</h2>
        <p>{t("installStore.sheetHint")}</p>
      </div>
      <SheetError attempt={props.attempt} />
      <Show when={resubmitting()}>
        <aside class="iv-setup-note" role="status" data-testid="install-resubmit">
          <strong>{t("installStore.resubmitTitle")}</strong>
          <p>{t("installStore.resubmitHint")}</p>
        </aside>
      </Show>

      <section class="iv-sheet-block" aria-labelledby="iv-planned-title" data-testid="install-planned-resources">
        <h3 id="iv-planned-title">{t("installStore.plannedTitle")}</h3>
        <PlannedResources resources={props.action.resources} />
        <p class="iv-muted">{t("installStore.plannedHint")}</p>
      </section>

      <Show when={props.action.connections.length > 0}>
        <section class="iv-sheet-block" aria-labelledby="iv-connections-title" data-testid="install-connections">
          <h3 id="iv-connections-title">{t("installStore.cloudConnection")}</h3>
          <p class="iv-muted">
            {view().missingConnections.length === 0 ? t("installStore.cloudConnected") : t("installStore.providerHint")}
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

      <section class="iv-sheet-block" aria-labelledby="iv-settings-title" data-testid="install-settings">
        <h3 id="iv-settings-title">{t("installStore.setupTitle")}</h3>
        <div class="iv-fields">
          <FormField
            label={t("installStore.name")}
            hint={t("installStore.nameHint")}
            error={view().nameProblem === "invalid"
              ? t("installStore.invalidName")
              : view().nameProblem === "conflict"
                ? t("installStore.nameTaken")
                : undefined}
            required
          >
            <Input
              value={nameText()}
              spellcheck={false}
              disabled={resubmitting()}
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
          <For each={requiredNames()}>
            {(name) => <Show when={variableFor(name)}>{(variable) => <VariableField variable={variable()} />}</Show>}
          </For>
        </div>
        <Show
          when={props.action.name.conflict && !resubmitting() &&
              props.action.name.proposed !== props.action.name.current &&
              nameText() !== props.action.name.proposed
            ? props.action.name.proposed
            : undefined}
        >
          {(proposed) => (
            <div class="iv-action-row iv-name-proposal">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={attempt().mutating() !== undefined}
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

      <Show when={view().primary === "review" && view().missingVariables.length > 0}>
        <p class="iv-muted" role="status">{t("installStore.settingsRequired")}</p>
      </Show>
      <div class="iv-action-row">
        <Button
          type="button"
          variant="primary"
          size="lg"
          busy={attempt().confirming()}
          disabled={view().primaryBlocked}
          onClick={() => {
            if (view().primary === "connect") openFirstMissing();
            else void attempt().confirm();
          }}
        >
          {view().primary === "connect" ? t("installStore.connect") : t("installStore.reviewChanges")}
        </Button>
        <StopButton attempt={props.attempt} />
      </div>
    </section>
  );
}
