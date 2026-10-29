/**
 * "Connect your cloud" form: create one ProviderConnection from a
 * service-installed credential recipe (guided fields, or the provider's OAuth
 * popup via lib/connection-oauth-popup.ts). The guided path is the default
 * whenever the service has one. A cloud without a guided method is connected
 * by typing the keys that cloud asks for, phrased as that behavior rather than
 * as raw environment variables. Shared by the 接続 page and the install review
 * (props are a stable API for both).
 *
 * Secret values are write-only — kept in component state only until the
 * submit resolves, then cleared. The embedding screen owns what happens next:
 * `onCreated` receives the saved connection, and `verifyConnection` runs the
 * first test of a connection saved from typed credentials (an OAuth
 * connection arrives already checked by its callback). Both callbacks still
 * fire after the form was closed, so the embedding screen guards its own
 * lifetime.
 */
import "../../../styles/wave-c.css";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  For,
  Index,
  type Resource,
  Show,
} from "solid-js";
import { Plus, Trash } from "lucide-solid";
import {
  isProviderEnvName,
  isReservedProviderEnvName,
} from "takosumi-contract";
import {
  providerSetupOptionsFromCredentialRecipes,
  type ProviderConnectionSetupOption,
} from "../../account/lib/api.ts";
import { ActionError, createAction } from "../../account/lib/action.tsx";
import {
  type ProviderConnection,
  createConnection,
  connectionSetupCatalog,
} from "../../../lib/control-api.ts";
import { connectProviderWithPopup } from "../../../lib/connection-oauth-popup.ts";
import { locale, t } from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  FormField,
  Input,
  Select,
  Toast,
} from "../../../components/ui/index.ts";

/** Sentinel `<select>` value for the custom provider credential path. */
const GENERIC_ENV_PROVIDER_OPTION = "__generic_env_provider__";

type ConnectionSetupCatalog = Awaited<ReturnType<typeof connectionSetupCatalog>>;

interface EnvPair {
  readonly name: string;
  readonly value: string;
}

export interface ConnectionCreateFormProps {
  /** Omitted when a signed-in person creates a personal connection. */
  readonly workspaceId?: string;
  /**
   * The credential-recipe catalog read, when the embedding screen already
   * holds one (the Connections tab labels its list from the same read). Read
   * once at mount; omitted, the form reads the catalog itself.
   */
  readonly setupCatalog?: Resource<ConnectionSetupCatalog>;
  /**
   * Provider source selected once the catalog settles (matched against recipe
   * sources and aliases). A source with no recipe opens the custom-key editor
   * with that provider name filled in.
   */
  readonly initialProviderSource?: string;
  /**
   * Keep the form on `initialProviderSource`: no provider picker, no switch
   * between presets and the custom-key editor.
   */
  readonly restrictToInitialProvider?: boolean;
  /**
   * Render the form card (default true). Closing keeps the draft — and an
   * in-flight OAuth popup — alive until reopened; unmount the form to discard
   * them.
   */
  readonly open?: boolean;
  /** A connection was saved; the form inputs are already cleared. */
  readonly onCreated: (connection: ProviderConnection) => void | Promise<void>;
  /**
   * First test of a connection saved from typed credentials, run after
   * `onCreated` settles. The embedding screen shows the result.
   */
  readonly verifyConnection: (connectionId: string) => void | Promise<void>;
  /** Shows a close action in the card header when provided. */
  readonly onCancel?: () => void;
}

function setupOptionMatchesSource(
  option: ProviderConnectionSetupOption,
  providerSource: string,
): boolean {
  return (
    option.providerSource === providerSource ||
    option.providerAliases.includes(providerSource)
  );
}

export default function ConnectionCreateForm(props: ConnectionCreateFormProps) {
  const workspaceId = () => props.workspaceId;
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const credentialRecipes =
    props.setupCatalog ?? createResource(connectionSetupCatalog)[0];
  const installedCredentialRecipes = () =>
    credentialRecipes.error ? [] : (credentialRecipes.latest?.recipes ?? []);
  const restrictedProviderSource = () =>
    props.restrictToInitialProvider ? props.initialProviderSource : undefined;
  const providerOptions = createMemo(() => {
    const options = providerSetupOptionsFromCredentialRecipes(
      installedCredentialRecipes(),
      locale(),
    );
    const restricted = restrictedProviderSource();
    return restricted
      ? options.filter((option) => setupOptionMatchesSource(option, restricted))
      : options;
  });

  // ----- register form state -----------------------------------------------
  // Service-installed recipes are the guided path. The raw bring-your-own-key
  // editor accepts an arbitrary provider source, but the saved connection
  // remains subject to provider policy, runner capability, and Run approval.
  const [provider, setProvider] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  // Secret material lives ONLY for the lifetime of the form; cleared on submit.
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [genericEnvProvider, setGenericEnvProvider] = createSignal("");
  const [envPairs, setEnvPairs] = createSignal<readonly EnvPair[]>([
    { name: "", value: "" },
  ]);
  const isGenericEnvProvider = () => provider() === GENERIC_ENV_PROVIDER_OPTION;
  /** The service accepts keys for clouds without a guided method. */
  const genericEnvAvailable = () =>
    installedCredentialRecipes().some(
      (recipe) =>
        recipe.id === "generic-env" &&
        recipe.authModes.env !== undefined &&
        Boolean(recipe.secretPartition),
    );

  let initialProviderSelected = false;
  createEffect(() => {
    const options = providerOptions();
    if (!initialProviderSelected && !credentialRecipes.loading && props.initialProviderSource) {
      initialProviderSelected = true;
      const match = options.find((option) => setupOptionMatchesSource(option, props.initialProviderSource!));
      if (match) setProvider(match.id);
      else { setProvider(GENERIC_ENV_PROVIDER_OPTION); setGenericEnvProvider(props.initialProviderSource); }
    }
    if (isGenericEnvProvider()) return;
    if (options.some((option) => option.id === provider())) return;
    if (options[0]) setProvider(options[0].id);
    else if (!credentialRecipes.loading)
      setProvider(GENERIC_ENV_PROVIDER_OPTION);
  });

  const setupOption = createMemo(() => {
    if (isGenericEnvProvider()) return undefined;
    return providerOptions().find((candidate) => candidate.id === provider());
  });
  const fields = createMemo(() => setupOption()?.fields ?? []);
  const setupGuide = createMemo(() => setupOption()?.setupGuide);
  const oauthHelper = createMemo(() => credentialRecipes.error ? undefined :
    credentialRecipes.latest?.oauthHelpers.find((helper) =>
      helper.providerSource === setupOption()?.providerSource ||
      setupOption()?.providerAliases.includes(helper.providerSource)));
  const oauthSetupFields = () => (oauthHelper()?.setupFields ?? []).filter((field) =>
    fields().some((candidate) => candidate.envName === field.envName && !candidate.secret));
  const [oauthBusy, setOauthBusy] = createSignal(false);
  const [oauthFailure, setOauthFailure] = createSignal(false);
  const [manualCredentials, setManualCredentials] = createSignal(false);
  let oauthController: AbortController | undefined;
  let oauthPopup: Window | null = null;
  const cancelOAuth = () => {
    oauthController?.abort(); oauthController = undefined;
    oauthPopup?.close(); oauthPopup = null;
    setOauthBusy(false);
  };
  onCleanup(cancelOAuth);
  let oauthWorkspace = workspaceId();
  let oauthProvider = provider();
  createEffect(() => {
    const current = workspaceId();
    const selected = provider();
    if (current !== oauthWorkspace || selected !== oauthProvider) {
      cancelOAuth(); setOauthFailure(false); setManualCredentials(false);
      oauthWorkspace = current; oauthProvider = selected;
    }
  });

  /**
   * Hands a saved connection to the embedding screen. A response for a
   * workspace the form has since switched away from is not this form's
   * result. Neither callback is gated on this form staying open or mounted:
   * the embedding screen may close the form in `onCreated` and still needs
   * the first test to run.
   */
  const connectionSaved = async (
    connection: ProviderConnection,
    verify: boolean,
  ) => {
    const matchesCurrentScope = () => {
      const workspace = workspaceId();
      return workspace
        ? connection.workspaceId === workspace
        : connection.workspaceId === undefined && connection.scope !== "operator";
    };
    if (!matchesCurrentScope()) return;
    clearForm();
    await props.onCreated(connection);
    if (verify && matchesCurrentScope()) {
      await props.verifyConnection(connection.id);
    }
  };

  const connectOAuth = async () => {
    const helper = oauthHelper();
    if (!helper || oauthBusy()) return;
    const popup = window.open("about:blank", "_blank", "popup,width=600,height=760");
    if (!popup) { setOauthFailure(true); return; }
    cancelOAuth(); oauthPopup = popup;
    const controller = new AbortController(); oauthController = controller;
    const targetWorkspace = workspaceId();
    setOauthBusy(true); setOauthFailure(false);
    try {
      const connection = await connectProviderWithPopup({ helper, workspaceId: targetWorkspace,
        displayName: displayName().trim() || undefined, signal: controller.signal, popup,
        scopeHints: { providerSettings: Object.fromEntries(oauthSetupFields().flatMap((field) =>
          values()[field.envName]?.trim() ? [[field.key, values()[field.envName]!.trim()]] : [])) } });
      if (disposed || controller.signal.aborted || workspaceId() !== targetWorkspace) return;
      await connectionSaved(connection, false);
    } catch {
      if (!disposed && !controller.signal.aborted && workspaceId() === targetWorkspace) setOauthFailure(true);
    } finally {
      if (oauthController === controller) cancelOAuth();
    }
  };

  const setFieldValue = (envName: string, value: string) => {
    setValues((prev) => ({ ...prev, [envName]: value }));
  };
  const setEnvPair = (index: number, patch: Partial<EnvPair>) => {
    setEnvPairs((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    );
  };
  const addEnvPair = () =>
    setEnvPairs((prev) => [...prev, { name: "", value: "" }]);
  const removeEnvPair = (index: number) =>
    setEnvPairs((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
    );

  const clearForm = () => {
    setValues({});
    setDisplayName("");
    // A restricted custom-key form keeps its fixed provider name.
    setGenericEnvProvider(restrictedProviderSource() ?? "");
    setEnvPairs([{ name: "", value: "" }]);
  };

  // Quiet advanced path: switch the add flow to the raw BYOK env editor.
  // Dropping any half-entered secret values mirrors the provider switcher.
  const openByokEditor = () => {
    setProvider(GENERIC_ENV_PROVIDER_OPTION);
    setValues({});
    setGenericEnvProvider("");
    setEnvPairs([{ name: "", value: "" }]);
  };

  // One generic submit path for every service-described setup option.
  const createFromRecipe = createAction(async () => {
    const option = setupOption();
    if (!option) throw new Error(t("conn.error.invalidProvider"));
    const submitValues: Record<string, string> = {};
    for (const field of option.fields) {
      const raw = (values()[field.envName] ?? "").trim();
      if (field.required && raw.length === 0) {
        throw new Error(t("conn.error.fieldRequired", { field: field.label }));
      }
      if (raw.length > 0) submitValues[field.envName] = raw;
    }
    const connection = await createConnection({
      ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
      provider: option.providerSource,
      credentialRecipe: option.credentialRecipe,
      displayName: displayName().trim() || option.label,
      values: submitValues,
    });
    await connectionSaved(connection, true);
  });

  // Generic ProviderConnection submit. This is the first-class path for any
  // provider not covered by a guided recipe.
  const createGenericEnvProvider = createAction(async () => {
    const name = genericEnvProvider().trim();
    if (!name) throw new Error(t("conn.genericEnv.providerRequired"));
    const submitValues: Record<string, string> = {};
    const seenEnvNames = new Set<string>();
    for (const pair of envPairs()) {
      const envName = pair.name.trim();
      const value = pair.value;
      if (envName.length === 0 && value.length === 0) continue;
      if (envName.length === 0) {
        throw new Error(t("conn.genericEnv.nameRequired"));
      }
      if (!isProviderEnvName(envName)) {
        throw new Error(t("conn.genericEnv.invalidName", { name: envName }));
      }
      if (isReservedProviderEnvName(envName)) {
        throw new Error(t("conn.genericEnv.reservedName", { name: envName }));
      }
      if (seenEnvNames.has(envName)) {
        throw new Error(t("conn.genericEnv.duplicateName", { name: envName }));
      }
      seenEnvNames.add(envName);
      submitValues[envName] = value;
    }
    if (Object.keys(submitValues).length === 0) {
      throw new Error(t("conn.genericEnv.oneRequired"));
    }
    const genericRecipe = installedCredentialRecipes().find(
      (recipe) =>
        recipe.id === "generic-env" &&
        recipe.authModes.env !== undefined &&
        recipe.secretPartition,
    );
    if (!genericRecipe?.secretPartition) {
      throw new Error(t("conn.error.invalidProvider"));
    }
    const connection = await createConnection({
      ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
      provider: name,
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: genericRecipe.secretPartition,
      },
      displayName: displayName().trim() || undefined,
      values: submitValues,
    });
    await connectionSaved(connection, true);
  });

  return (
    <Show when={props.open ?? true}>
      <Card>
        <CardHeader
          title={t("conn.add.title")}
          actions={
            <Show when={props.onCancel}>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => props.onCancel?.()}
              >
                {t("conn.add.close")}
              </Button>
            </Show>
          }
        />
        <div class="wc-form">
          <Show
            when={
              !isGenericEnvProvider() &&
              // A restricted form still offers that provider's sign-in methods.
              (!restrictedProviderSource() || providerOptions().length > 1)
            }
          >
            {/* Every option and field comes from the service recipe list. */}
            <FormField label={t("conn.add.provider")}>
              <Select
                id="connection-provider"
                name="provider"
                value={provider()}
                onChange={(e) => {
                  setProvider(e.currentTarget.value);
                  // Switching provider drops any half-entered secret values.
                  setValues({});
                  setGenericEnvProvider("");
                  setEnvPairs([{ name: "", value: "" }]);
                }}
              >
                <For each={providerOptions()}>
                  {(option) => (
                    <option value={option.id}>{option.label}</option>
                  )}
                </For>
              </Select>
            </FormField>
          </Show>

          <FormField
            label={t("conn.add.displayName")}
            hint={t("conn.add.displayNameHint")}
          >
            <Input
              id="connection-display-name"
              name="displayName"
              type="text"
              value={displayName()}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
              placeholder={t("conn.add.displayNamePlaceholder")}
              autocomplete="off"
            />
          </FormField>

          <Show when={!isGenericEnvProvider() && oauthHelper()}>
            <For each={oauthSetupFields()}>{(field) => <FormField
              label={fields().find((candidate) => candidate.envName === field.envName)?.label ?? field.key}
              hint={t("conn.oauth.accountSettingsHint")}>
              <Input value={values()[field.envName] ?? ""} onInput={(event) => setFieldValue(field.envName, event.currentTarget.value)} autocomplete="off" />
            </FormField>}</For>
            <div class="wc-form-actions">
              <Button type="button" variant="primary" busy={oauthBusy()} onClick={() => void connectOAuth()}>
                {t("conn.oauth.connect", { provider: installedCredentialRecipes().find((recipe) => recipe.id === oauthHelper()?.credentialRecipe.id)?.displayName ?? "" })}
              </Button>
              <Show when={oauthBusy()}><Button type="button" variant="ghost" onClick={cancelOAuth}>{t("common.cancel")}</Button></Show>
            </div>
            <Show when={oauthBusy()}><p role="status">{t("conn.oauth.waiting")}</p></Show>
            <Show when={oauthFailure()}><Toast tone="error">{t("conn.oauth.retryHint")}</Toast></Show>
            <Button type="button" variant="ghost" onClick={() => setManualCredentials((value) => !value)} aria-expanded={manualCredentials()}>{t("conn.oauth.manual")}</Button>
          </Show>

          <Show
            when={isGenericEnvProvider()}
            fallback={
              <div hidden={Boolean(oauthHelper()) && !manualCredentials()}>
                <Show when={setupOption()?.description}>
                  {(description) => <p class="muted">{description()}</p>}
                </Show>
                <Show when={setupGuide()}>
                  {(guide) => (
                    <div class="wc-guided">
                      <div class="wc-form-actions">
                        <Button
                          variant="secondary"
                          href={guide().url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("conn.guided.openProvider", {
                            provider: setupOption()?.label ?? "",
                          })}
                        </Button>
                      </div>
                      <Show when={guide().steps.length > 0}>
                        <ol class="wc-steps">
                          <For each={guide().steps}>
                            {(step) => <li>{step}</li>}
                          </For>
                        </ol>
                      </Show>
                    </div>
                  )}
                </Show>
                <form
                  class="wc-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void createFromRecipe.run();
                  }}
                >
                  <Index each={fields()}>
                    {(field) => (
                      <FormField
                        label={field().label}
                        required={field().required}
                      >
                        <Input
                          id={`connection-field-${field().envName}`}
                          name={`field:${field().envName}`}
                          type={field().secret ? "password" : "text"}
                          value={values()[field().envName] ?? ""}
                          onInput={(e) =>
                            setFieldValue(
                              field().envName,
                              e.currentTarget.value,
                            )
                          }
                          placeholder={field().placeholder}
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </FormField>
                    )}
                  </Index>
                  <div class="wc-form-actions">
                    <Button
                      variant="primary"
                      type="submit"
                      busy={createFromRecipe.busy()}
                    >
                      {createFromRecipe.busy()
                        ? t("conn.registering")
                        : t("conn.register")}
                    </Button>
                  </div>
                  <ActionError error={createFromRecipe.error} />
                </form>
              </div>
            }
          >
            {/* A cloud without a guided method: type the keys it asks for.
                h2 keeps the heading hierarchy flat under the page h1, like
                sibling sections. */}
            <div class="wc-guided">
              <div class="wc-byok-intro">
                <h2 class="wc-byok-title">{t("conn.byok.title")}</h2>
                <p class="muted">{t("conn.byok.body")}</p>
                <p class="wc-byok-note">{t("conn.byok.noBillingNote")}</p>
              </div>
              <Show when={!credentialRecipes.loading && !genericEnvAvailable()}>
                <Toast tone="neutral">{t("conn.byok.unavailable")}</Toast>
              </Show>
              <Show when={!restrictedProviderSource()}>
                <div class="wc-form-actions">
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      setProvider(providerOptions()[0]?.id ?? "");
                      setGenericEnvProvider("");
                      setEnvPairs([{ name: "", value: "" }]);
                    }}
                  >
                    {t("conn.byok.usePreset")}
                  </Button>
                </div>
              </Show>
              <form
                class="wc-form"
                hidden={!credentialRecipes.loading && !genericEnvAvailable()}
                onSubmit={(e) => {
                  e.preventDefault();
                  void createGenericEnvProvider.run();
                }}
              >
                <FormField
                  label={t("conn.genericEnv.providerName")}
                  hint={t("conn.genericEnv.providerHint")}
                  required
                >
                  <Input
                    id="connection-generic-provider"
                    name="genericProvider"
                    type="text"
                    value={genericEnvProvider()}
                    onInput={(e) =>
                      setGenericEnvProvider(e.currentTarget.value)
                    }
                    placeholder={t("conn.genericEnv.providerPlaceholder")}
                    autocomplete="off"
                    spellcheck={false}
                    readonly={Boolean(restrictedProviderSource())}
                  />
                </FormField>

                <Index each={envPairs()}>
                  {(pair, index) => (
                    <div class="wc-env-pair">
                      <FormField label={t("conn.genericEnv.envName")}>
                        <Input
                          id={`connection-generic-env-name-${index}`}
                          name={`genericEnvName:${index}`}
                          type="text"
                          value={pair().name}
                          onInput={(e) =>
                            setEnvPair(index, { name: e.currentTarget.value })
                          }
                          placeholder={t(
                            "conn.genericEnv.envNamePlaceholder",
                          )}
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </FormField>
                      <FormField label={t("conn.genericEnv.value")}>
                        <Input
                          id={`connection-generic-env-value-${index}`}
                          name={`genericEnvValue:${index}`}
                          type="password"
                          value={pair().value}
                          onInput={(e) =>
                            setEnvPair(index, {
                              value: e.currentTarget.value,
                            })
                          }
                          placeholder={t("conn.genericEnv.valuePlaceholder")}
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </FormField>
                      <Show when={envPairs().length > 1}>
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => removeEnvPair(index)}
                          icon={<Trash size={16} />}
                        >
                          {t("conn.genericEnv.removeRow")}
                        </Button>
                      </Show>
                    </div>
                  )}
                </Index>

                <div class="wc-form-actions">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => addEnvPair()}
                    icon={<Plus size={16} />}
                  >
                    {t("conn.genericEnv.addRow")}
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    busy={createGenericEnvProvider.busy()}
                  >
                    {createGenericEnvProvider.busy()
                      ? t("conn.registering")
                      : t("conn.register")}
                  </Button>
                </div>
                <ActionError error={createGenericEnvProvider.error} />
              </form>
            </div>
          </Show>

          <Show when={!isGenericEnvProvider() && !restrictedProviderSource()}>
            {/* A cloud missing from the list connects by typing its keys. */}
            <div class="wc-form-actions">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={openByokEditor}
              >
                {t("conn.add.genericEnvOption")}
              </Button>
            </div>
          </Show>
        </div>
      </Card>
    </Show>
  );
}
