/**
 * Settings: the app's values and which connection each provider uses.
 *
 * Changing either does not save anything by itself. "Review" creates one
 * reviewed configuration successor and its Plan; the in-page review shows the
 * exact changes and cost, and only "Allow and apply" applies them. The
 * screen definition (Interface blueprints) belongs to the app's Git
 * repository and is sent back unchanged; provider aliases only tell rows
 * apart when one provider appears more than once.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  Match,
  on,
  Show,
  Suspense,
  Switch,
} from "solid-js";
import { useBeforeLeave } from "@solidjs/router";
import { PlugZap } from "lucide-solid";
import {
  installExperienceArtifact,
  installExperienceInitialSecret,
  installExperienceOidcClient,
  installExperiencePublicEndpoint,
  installExperienceServiceNameVariable,
} from "takosumi-contract";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import {
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
  Spinner,
  Textarea,
} from "../../components/ui/index.ts";
import {
  createCapsuleConfigurationPlan,
  type AppConnectionChoice,
  type InstallConfig,
  type ProviderBinding,
  type ProviderBindings,
  type ProviderConnection,
  testConnection,
} from "../../lib/control-api.ts";
import {
  buildConfigVariablePatch,
  type ConfigVariableRow,
  configRowsFromInstallConfig,
} from "../../lib/capsules-ui.ts";
import {
  isProviderConnectionCandidate,
} from "../../lib/provider-connections.ts";
import { providerConnectionStatusLabel } from "../../lib/labels.ts";
import { providerRowLabels } from "../../lib/app-page.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { randomUuid } from "../../lib/random-uuid.ts";
import { locale, t } from "../../i18n/index.ts";
import ConnectionCreateForm from "../workspace/connections/ConnectionCreateForm.tsx";
import { AppSection } from "./app-ui.tsx";

function providerTail(provider: string): string {
  const normalized = provider.toLowerCase().trim();
  return normalized.split("/").at(-1) ?? normalized;
}

/** Connections that can serve this provider row. */
function connectionChoices(
  provider: string,
  connections: readonly ProviderConnection[],
  memberChoices?: readonly AppConnectionChoice[],
): readonly Pick<ProviderConnection, "id" | "displayName" | "providerSource">[] {
  if (memberChoices) return memberChoices.filter((connection) => sameProviderSource(provider, connection.providerSource));
  return connections.filter(
    (connection) =>
      isProviderConnectionCandidate(connection) &&
      sameProviderSource(provider, connection.providerSource),
  );
}

/**
 * The reviewed binding set: every row exactly as stored, with only the chosen
 * connection changed. Legacy `alias` becomes `rootAlias`, as the API expects.
 */
function reviewedBindings(
  rows: readonly ProviderBinding[],
  connections: readonly ProviderConnection[],
  memberChoices?: readonly AppConnectionChoice[],
): { readonly bindings: ProviderBindings } | { readonly error: string } {
  const bindings: ProviderBinding[] = [];
  for (const row of rows) {
    if (!connectionChoices(row.provider, connections, memberChoices).some((c) => c.id === row.connectionId)) {
      return { error: t("app.settings.connectionMissing", { provider: providerRowLabels([row])[0]! }) };
    }
    const rootAlias = row.rootAlias ?? row.alias;
    bindings.push({
      provider: row.provider,
      moduleLocalName: row.moduleLocalName ?? providerTail(row.provider),
      ...(row.childAlias ? { childAlias: row.childAlias } : {}),
      ...(rootAlias ? { rootAlias } : {}),
      connectionId: row.connectionId,
      ...(row.region ? { region: row.region } : {}),
      ...(row.runCredentialSettings
        ? { runCredentialSettings: row.runCredentialSettings }
        : {}),
    });
  }
  return { bindings };
}

/** Values the install experience owns (domain, sign-in, artifact). */
function experienceVariableNames(config: InstallConfig | undefined): ReadonlySet<string> {
  const experience = config?.installExperience;
  const endpoint = installExperiencePublicEndpoint(experience);
  const secret = installExperienceInitialSecret(experience);
  const oidc = installExperienceOidcClient(experience);
  const artifact = installExperienceArtifact(experience);
  return new Set(
    [
      installExperienceServiceNameVariable(experience),
      endpoint?.subdomainVariable,
      endpoint?.urlVariable,
      endpoint?.routePatternVariable,
      secret?.variable,
      oidc?.issuerUrlVariable,
      oidc?.accountsUrlVariable,
      oidc?.clientIdVariable,
      oidc?.redirectUriVariable,
      artifact?.urlVariable,
      artifact?.sha256Variable,
    ].filter((name): name is string => Boolean(name)),
  );
}

export default function AppSettingsSection(props: {
  readonly capsuleId: string;
  readonly workspaceId?: string;
  readonly member?: boolean;
  readonly accessKnown?: boolean;
  readonly memberConnectionChoices?: readonly AppConnectionChoice[];
  readonly canCreateConnection?: boolean;
  readonly installConfig: InstallConfig | undefined;
  readonly installConfigLoading: boolean;
  /** The configuration the app runs now; the form must be read from it. */
  readonly capsuleInstallConfigId: string;
  /** Changes when a settings review closes unapplied: the form re-reads what the app runs. */
  readonly seed: number;
  readonly authorityGuard: string | undefined;
  readonly bindings: ProviderBindings | undefined;
  readonly bindingsFailed: boolean;
  readonly connections: readonly ProviderConnection[];
  readonly onConnectionsChanged: () => void;
  readonly reviewBusy: boolean;
  /** Another change is under way or waiting for review, so settings wait. */
  readonly changeWaits?: boolean;
  readonly starting: boolean;
  readonly error?: string;
  readonly notice?: string;
  readonly onReview: (create: () => Promise<string | undefined>) => void;
  readonly review: JSX.Element;
}): JSX.Element {
  const { confirm } = useConfirmDialog();
  const [rows, setRows] = createSignal<ProviderBinding[]>([]);
  const [bindingsDirty, setBindingsDirty] = createSignal(false);
  const [variableRows, setVariableRows] = createSignal<ConfigVariableRow[]>([]);
  const [formError, setFormError] = createSignal<string>();
  const [connecting, setConnecting] = createSignal<number>();
  const [connectionMessages, setConnectionMessages] = createSignal<
    Readonly<Record<number, string>>
  >({});
  // Reuse the key only while retrying byte-identical reviewed intent whose
  // outcome is unknown or failed. If the first response is lost after the
  // server commits, the next click observes the canonical successor/Plan
  // instead of minting a second authority. Once the Plan id comes back the
  // key is released: the server would replay that Plan for it.
  let configurationAttempt:
    | { readonly requestJson: string; readonly idempotencyKey: string }
    | undefined;
  const review = props.review;

  createEffect(
    on(
      [() => props.bindings, () => props.seed],
      ([bindings]) => {
        if (!bindings) return;
        setRows([...bindings]);
        setBindingsDirty(false);
      },
    ),
  );
  // Seed only from the install config: `on` keeps a language switch from
  // re-seeding the rows and discarding unsaved edits.
  createEffect(
    on(
      [() => props.installConfig, () => props.seed],
      ([config]) => setVariableRows([...configRowsFromInstallConfig(config, locale())]),
    ),
  );

  const dirty = () =>
    bindingsDirty() ||
    variableRows().some((row) => row.dirty || row.deleted === true || row.resetToDefault);
  useBeforeLeave((event) => {
    if (event.defaultPrevented || !dirty()) return;
    event.preventDefault();
    void (async () => {
      const proceed = await confirm({
        title: t("app.settings.leaveConfirm.title"),
        message: t("app.settings.leaveConfirm.body"),
        confirmText: t("app.settings.leaveConfirm.confirm"),
        cancelText: t("common.cancel"),
      });
      if (proceed) event.retry(true);
    })();
  });

  // User edits (and only user edits) mark a row dirty, so an untouched row is
  // never written over the module's own default. Editing cancels a reset.
  const editVariable = (id: string, patch: Partial<ConfigVariableRow>) =>
    setVariableRows((prev) =>
      prev.map((row) =>
        row.id === id ? { ...row, ...patch, dirty: true, resetToDefault: false } : row,
      ),
    );
  // Declared values reset to their default (undoable until reviewed); values
  // the app no longer declares are removed.
  const resetVariable = (id: string) =>
    setVariableRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        if (!row.storeField) return { ...row, deleted: true };
        if (row.resetToDefault) {
          return { ...row, resetToDefault: false, dirty: false, value: row.savedValue };
        }
        return {
          ...row,
          value: row.defaultText,
          dirty: false,
          resetToDefault: row.hasExistingValue,
        };
      }),
    );
  const experienceNames = createMemo(() => experienceVariableNames(props.installConfig));
  const visibleRows = createMemo(() => variableRows().filter((row) => !row.deleted));
  const declaredRows = createMemo(() =>
    visibleRows().filter(
      (row) => row.storeField && (!row.advanced || experienceNames().has(row.name)),
    ),
  );
  const optionalRows = createMemo(() =>
    visibleRows().filter(
      (row) => row.storeField && row.advanced && !experienceNames().has(row.name),
    ),
  );
  const otherRows = createMemo(() => visibleRows().filter((row) => !row.storeField));
  const rowLabels = createMemo(() => providerRowLabels(rows()));

  const chooseConnection = (index: number, connectionId: string) => {
    setBindingsDirty(true);
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, connectionId } : row)));
  };
  const setConnectionMessage = (index: number, message?: string) =>
    setConnectionMessages((current) => {
      const next = { ...current };
      if (message) next[index] = message;
      else delete next[index];
      return next;
    });
  const adoptConnection = (index: number, connectionId: string) => {
    props.onConnectionsChanged();
    chooseConnection(index, connectionId);
    setConnectionMessage(index);
    setConnecting(undefined);
  };
  // Typed credentials are tested once after saving, as on the connections
  // screen. OAuth connections arrive verified and skip the test.
  const verifyConnection = async (index: number, connectionId: string) => {
    try {
      const result = (await testConnection(connectionId)) as { readonly status?: string } | undefined;
      if (result?.status && result.status !== "verified") {
        setConnectionMessage(index, t("conn.test.notReady", {
          status: providerConnectionStatusLabel(result.status),
        }));
      }
    } catch (cause) {
      setConnectionMessage(index, friendlyError(cause, t).message);
    }
    props.onConnectionsChanged();
  };

  /**
   * The values and the authority guard come from separate reads. Review is
   * offered only when the form was read from the configuration the app runs
   * now, so a refresh after an apply can never pair the previous version's
   * screens with the new guard.
   */
  const configCurrent = () =>
    !props.installConfigLoading &&
    props.installConfig !== undefined &&
    props.installConfig.id === props.capsuleInstallConfigId;

  const submit = () => {
    setFormError(undefined);
    const config = props.installConfig;
    const guard = props.authorityGuard;
    if (!config || !guard || props.bindings === undefined || !configCurrent()) {
      setFormError(t("app.settings.notReady"));
      return;
    }
    const bindings = props.member && !bindingsDirty()
      ? { bindings: rows() } : reviewedBindings(rows(), props.connections, props.memberConnectionChoices);
    if ("error" in bindings) {
      setFormError(bindings.error);
      return;
    }
    const patch = buildConfigVariablePatch(variableRows());
    if ("error" in patch) {
      setFormError(patch.error);
      return;
    }
    const request = {
      variablePatch: { set: patch.variableMapping, remove: patch.removeVariables },
      providerBindings: bindings.bindings,
      // The screen definition comes from the app's repository: sent back as is.
      interfaceBlueprints: config.interfaceBlueprints ?? [],
      expected: { authorityGuard: guard },
    };
    const requestJson = JSON.stringify(request);
    const idempotencyKey =
      configurationAttempt?.requestJson === requestJson
        ? configurationAttempt.idempotencyKey
        : randomUuid();
    configurationAttempt = { requestJson, idempotencyKey };
    props.onReview(async () => {
      const result = await createCapsuleConfigurationPlan(props.capsuleId, request, idempotencyKey);
      // The reviewed successor and its Plan exist now: release the key and
      // mark the form clean, so leaving is not blocked and the next change
      // is a new request rather than a replay of this one.
      if (configurationAttempt?.idempotencyKey === idempotencyKey) configurationAttempt = undefined;
      setBindingsDirty(false);
      setVariableRows((current) =>
        current.map((row) => ({ ...row, dirty: false, deleted: false, resetToDefault: false })),
      );
      return result.configurationPlan.planRunId;
    });
  };

  return (
    <AppSection
      id="settings"
      title={t("app.settings.title")}
      subtitle={t("app.settings.subtitle")}
      testId="app-settings"
    >
      <form
        class="ap-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Switch>
          <Match when={props.installConfigLoading && !props.installConfig}>
            <Spinner size={18} />
          </Match>
          <Match when={!props.installConfig}>
            <p class="ap-muted">{t("app.settings.notReady")}</p>
          </Match>
          <Match when={props.installConfig}>
            <Show
              when={declaredRows().length + optionalRows().length + otherRows().length > 0}
              fallback={<p class="ap-muted">{t("app.settings.noValues")}</p>}
            >
              <VariableRows rows={declaredRows()} onChange={editVariable} onReset={resetVariable} />
              <Show when={optionalRows().length > 0}>
                <h3>{t("app.settings.optionalTitle")}</h3>
                <VariableRows rows={optionalRows()} onChange={editVariable} onReset={resetVariable} />
              </Show>
              <Show when={otherRows().length > 0}>
                <h3>{t("app.settings.otherTitle")}</h3>
                <p class="ap-muted">{t("app.settings.otherHint")}</p>
                <VariableRows rows={otherRows()} onChange={editVariable} onReset={resetVariable} />
              </Show>
            </Show>
          </Match>
        </Switch>

        <div class="ap-subsection" id="connections" data-testid="app-connections">
          <h3>{t("app.settings.connectionsTitle")}</h3>
          <Switch>
            <Match when={props.bindingsFailed}>
              <p class="wa-error" role="alert">{t("app.settings.connectionsLoadFailed")}</p>
            </Match>
            <Match when={props.bindings === undefined}>
              <Spinner size={18} />
            </Match>
            <Match when={rows().length === 0}>
              <p class="ap-muted">{t("app.settings.connectionsNone")}</p>
            </Match>
            <Match when={rows().length > 0}>
              <p class="ap-muted">{t("app.settings.connectionsHint")}</p>
              <Index each={rows()}>
                {(row, index) => {
                  const choices = () => connectionChoices(row().provider, props.connections, props.memberConnectionChoices);
                  const selected = () => choices().find((c) => c.id === row().connectionId);
                  const bound = () => selected() || (props.member && row().connectionId);
                  const formId = `app-connect-${index}`;
                  return (
                    <article
                      class="iv-connection-row"
                      data-testid="app-connection-row"
                      data-provider-source={row().provider}
                      data-connection-state={bound() ? "connected" : "missing"}
                    >
                      <div class="iv-connection-head">
                        <strong>{rowLabels()[index]}</strong>
                        <Badge tone={bound() ? "ok" : "warn"}>
                          {bound() ? t("app.settings.connected") : t("app.settings.notConnected")}
                        </Badge>
                      </div>
                      <Show when={props.accessKnown !== false && (!props.member || props.memberConnectionChoices !== undefined)} fallback={<p class="ap-muted">{t("app.sharing.ownerConnectionsOnly")}</p>}>
                      <FormField label={t("app.settings.connectionLabel")}>
                        <Select
                          value={row().connectionId}
                          onChange={(event) => chooseConnection(index, event.currentTarget.value)}
                        >
                          <option value="" selected={!selected()}>
                            {t("app.settings.chooseConnection")}
                          </option>
                          <For each={choices()}>
                            {(connection) => (
                              <option value={connection.id} selected={connection.id === row().connectionId}>
                                {connection.displayName || connection.id}
                              </option>
                            )}
                          </For>
                        </Select>
                      </FormField>
                      </Show>
                      <Show when={props.canCreateConnection !== false}>
                      <div class="ap-row-actions">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          icon={<PlugZap size={16} />}
                          aria-expanded={connecting() === index}
                          aria-controls={formId}
                          onClick={() => setConnecting((current) => (current === index ? undefined : index))}
                        >
                          {connecting() === index
                            ? t("app.settings.closeConnect")
                            : choices().length === 0
                              ? t("app.settings.connect")
                              : t("app.settings.connectAnother")}
                        </Button>
                      </div>
                      </Show>
                      <Show when={connectionMessages()[index]}>
                        {(message) => <p class="ap-muted" role="alert">{message()}</p>}
                      </Show>
                      <Show when={props.canCreateConnection !== false && connecting() === index}>
                        <div class="iv-inline-connect" id={formId}>
                          {/* The form reads the setup catalog; suspend here,
                              not the whole page. */}
                          <Suspense fallback={<div role="status"><Spinner size={18} />{t("common.loading")}</div>}>
                            <ConnectionCreateForm
                              workspaceId={props.workspaceId}
                              initialProviderSource={row().provider}
                              restrictToInitialProvider
                              onCreated={(connection) => adoptConnection(index, connection.id)}
                              verifyConnection={(connectionId) => verifyConnection(index, connectionId)}
                            />
                          </Suspense>
                        </div>
                      </Show>
                    </article>
                  );
                }}
              </Index>
            </Match>
          </Switch>
        </div>

        <Show when={formError() ?? props.error}>
          {(message) => <p class="wa-error" role="alert">{message()}</p>}
        </Show>
        <Show when={props.notice}>
          {(message) => <p class="ap-notice" role="status">{message()}</p>}
        </Show>
        <Show when={props.changeWaits}>
          <p class="ap-muted" role="status" data-settings-waits>{t("app.settings.changeWaits")}</p>
        </Show>
        <div class="ap-row-actions">
          <Button
            variant="primary"
            type="submit"
            busy={props.starting}
            disabled={
              props.accessKnown === false ||
              props.reviewBusy ||
              !configCurrent() ||
              !props.authorityGuard ||
              props.bindings === undefined ||
              !dirty()
            }
          >
            {t("app.settings.review")}
          </Button>
        </div>
      </form>
      {review}
    </AppSection>
  );
}

/** True when a declared row shows the module default (nothing will be written). */
function rowPresentsDefault(row: ConfigVariableRow): boolean {
  return row.storeField && !row.dirty && (row.resetToDefault || !row.hasExistingValue);
}

function variableRowHint(row: ConfigVariableRow): string | undefined {
  if (row.resetToDefault) return t("app.config.resetPendingHint");
  if (row.secret && row.hasExistingValue && row.value.trim() === "") {
    return t("app.config.secretHint");
  }
  if (rowPresentsDefault(row)) {
    return row.helper
      ? `${row.helper} — ${t("app.config.defaultBadge")}`
      : t("app.config.defaultBadge");
  }
  return row.helper;
}

function configControlId(row: ConfigVariableRow): string {
  return `app-config-${row.id.replace(/[^a-z0-9_-]+/giu, "-")}`;
}

function VariableRows(props: {
  readonly rows: readonly ConfigVariableRow[];
  readonly onChange: (id: string, patch: Partial<ConfigVariableRow>) => void;
  readonly onReset: (id: string) => void;
}) {
  // <Index>: onChange replaces the edited row object per keystroke, so a
  // reference-keyed <For> would recreate the focused input on every character.
  return (
    <div class="ap-variables">
      <Index each={props.rows}>
        {(row) => (
          <div class="ap-variable-row">
            <FormField
              label={row().storeField ? row().label : row().name}
              hint={variableRowHint(row())}
              required={row().required}
              as={row().type === "boolean" ? "group" : "label"}
            >
              <ConfigVariableInput row={row()} onChange={props.onChange} />
            </FormField>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={
                row().storeField
                  ? row().resetToDefault
                    ? t("app.config.undoResetAria", { name: row().label })
                    : t("app.config.resetAria", { name: row().label })
                  : t("app.config.removeAria", { name: row().name })
              }
              onClick={() => props.onReset(row().id)}
            >
              {row().storeField
                ? row().resetToDefault
                  ? t("app.config.undoReset")
                  : t("app.config.reset")
                : t("app.config.remove")}
            </Button>
          </div>
        )}
      </Index>
    </div>
  );
}

function ConfigVariableInput(props: {
  readonly row: ConfigVariableRow;
  readonly onChange: (id: string, patch: Partial<ConfigVariableRow>) => void;
}) {
  const setValue = (value: string) => props.onChange(props.row.id, { value });
  const id = () => configControlId(props.row);
  const name = () => `configValue:${props.row.name || props.row.id}`;
  return (
    <Switch>
      <Match when={props.row.type === "boolean"}>
        <Checkbox
          id={id()}
          name={name()}
          checked={props.row.value === "true"}
          onChange={(event) => setValue(event.currentTarget.checked ? "true" : "false")}
          label={t("app.config.enabled")}
        />
      </Match>
      <Match when={props.row.type === "json"}>
        <Textarea
          id={id()}
          name={name()}
          rows={4}
          value={props.row.value}
          placeholder={props.row.placeholder}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      </Match>
      <Match when={props.row.type === "number"}>
        <Input
          id={id()}
          name={name()}
          type="number"
          value={props.row.value}
          placeholder={props.row.placeholder}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      </Match>
      <Match when={props.row.type === "string"}>
        <Input
          id={id()}
          name={name()}
          type={props.row.secret ? "password" : "text"}
          value={props.row.value}
          placeholder={props.row.placeholder}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      </Match>
    </Switch>
  );
}
