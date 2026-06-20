/**
 * Add a Capsule (`/new`) — examples + Git URL, one flow.
 *
 * Three entry shapes, identical install path:
 *   - Examples: curated first-party / known Capsule coordinates (src/catalog.ts).
 *     Picking one pre-fills the Git tab.
 *   - Git URL: the raw source form (the developer power path).
 *   - External install link: another site links `/install?git=…` (or the
 *     packed `?source=git::…` form); the router forwards the query here and
 *     lib/install-link.ts seeds the Git form. A link only PRE-FILLS — the
 *     summary states the provenance and the visitor still confirms in this
 *     client (compatibility check → explicit add). No worker-side handling.
 *
 * The flow runs five explicit steps — register/fetch → compatibility →
 * provider connection review → create the current compatibility record → plan — and
 * lands on `/runs/:id`. A 409 source_sync_required surfaces a humane retry
 * instead of a raw error. OSS Takosumi requires a ready Provider Connection
 * before apply.
 */
import "../../styles/wave-b.css";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { Download } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId } from "../../lib/space-state.ts";
import {
  capsuleNameFromUrl,
  parseInstallPrefill,
} from "../../lib/install-link.ts";
import {
  installReturnPathFromPrefill,
  providerConnectionsHrefForInstallReturn,
} from "../../lib/install-return-context.ts";
import { CATALOG, type CatalogEntry } from "../../catalog.ts";
import {
  checkCapsuleCompatibility,
  ControlApiError,
  createInstallation,
  createSource,
  extractRunId,
  type InstallationProviderConnectionBindings,
  type CapsuleCompatibilityLevel,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  listProviderConnections,
  listInstallConfigs,
  planInstallation,
  putInstallationProviderConnectionSet,
  syncSource,
  waitForLatestSourceSnapshot,
  type CapsuleCompatibilityProvider,
  type ProviderConnection,
  type ProviderCredentialOwnership,
} from "../../lib/control-api.ts";
import { locale, t } from "../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  Select,
  type Tone,
} from "../../components/ui/index.ts";

type StepState = "idle" | "running" | "done" | "error";

interface ProviderConnectionRow {
  readonly provider: string;
  readonly alias: string;
  readonly connectionId: string;
  readonly ownershipOptions: readonly ProviderCredentialOwnership[];
  readonly resourceTypes: readonly string[];
}

function compatibilityTone(level: CapsuleCompatibilityLevel): Tone {
  switch (level) {
    case "ready":
    case "auto_capsulized":
      return "ok";
    case "needs_patch":
      return "warn";
    case "unsupported":
      return "danger";
  }
}

function compatibilityLabel(level: CapsuleCompatibilityLevel): string {
  switch (level) {
    case "ready":
      return t("new.compat.ready");
    case "auto_capsulized":
      return t("new.compat.auto");
    case "needs_patch":
      return t("new.compat.patch");
    case "unsupported":
      return t("new.compat.unsupported");
  }
}

function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/iu.test(value.trim());
}

function displayRef(value: string): string {
  const trimmed = value.trim();
  return isFullCommitSha(trimmed) ? trimmed.slice(0, 8) : trimmed;
}

export default function NewAppView() {
  return <Page title={t("new.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const navigate = useNavigate();

  // External install link (client-handled): another site links
  // `/install?git=…` (or the packed `?source=git::…` form), the router
  // forwards the query here, and the parser seeds the Git form. A link only
  // PRE-FILLS — the visitor still confirms in this client (compatibility
  // check, then the explicit add button).
  const prefill =
    typeof location === "undefined"
      ? undefined
      : parseInstallPrefill(location.search);

  const [activeTab, setActiveTab] = createSignal<"catalog" | "git">(
    prefill ? "git" : "catalog",
  );
  const initialRef = prefill?.ref || "main";
  const [gitUrl, setGitUrl] = createSignal(prefill?.git ?? "");
  const [ref, setRef] = createSignal(displayRef(initialRef));
  const [pinnedFullRef, setPinnedFullRef] = createSignal<string | null>(
    isFullCommitSha(initialRef) ? initialRef : null,
  );
  const [path, setPath] = createSignal(prefill?.path || ".");
  const [name, setName] = createSignal(
    prefill ? capsuleNameFromUrl(prefill.git) : "",
  );
  const [installConfigId, setInstallConfigId] = createSignal("");
  const [compatibility, setCompatibility] =
    createSignal<CapsuleCompatibilityResult | null>(null);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);
  const [providerRows, setProviderRows] = createSignal<ProviderConnectionRow[]>(
    [],
  );

  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [configs] = createResource(spaceId, listInstallConfigs);
  const [providerConnections] = createResource(
    spaceId,
    listProviderConnections,
  );
  const configList = createMemo<readonly InstallConfig[]>(
    () => configs() ?? [],
  );
  const defaultGitInstallConfig = () =>
    configList().find((config) => config.sourceKind === "generic_capsule");
  const ensureConfigSelected = () => {
    const list = configList();
    if (list.length === 0) return list;
    const current = installConfigId();
    if (!current || !list.some((config) => config.id === current)) {
      setInstallConfigId(defaultGitInstallConfig()?.id ?? "");
    }
    return list;
  };
  const selectedInstallConfigId = () => {
    ensureConfigSelected();
    return installConfigId();
  };

  // Step machine: keep the created Source id so a retry resumes mid-flow.
  const [createdSourceId, setCreatedSourceId] = createSignal<string | null>(
    null,
  );
  const [stepSource, setStepSource] = createSignal<StepState>("idle");
  const [stepSync, setStepSync] = createSignal<StepState>("idle");
  const [stepInstall, setStepInstall] = createSignal<StepState>("idle");
  const [stepPlan, setStepPlan] = createSignal<StepState>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [syncRequired, setSyncRequired] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const validate = (): string | null => {
    if (!spaceId()) return t("new.error.spaceRequired");
    if (!gitUrl().trim()) return t("new.error.urlRequired");
    if (!name().trim()) return t("new.error.nameRequired");
    if (!selectedInstallConfigId()) return t("new.error.configMissing");
    return null;
  };
  const effectiveRef = () => {
    const current = ref().trim();
    const pinned = pinnedFullRef();
    if (pinned && current === displayRef(pinned)) return pinned;
    return current || "main";
  };
  const currentInstallReturnPath = () =>
    installReturnPathFromPrefill({
      git: gitUrl(),
      ref: effectiveRef(),
      path: path().trim() || ".",
    });
  const providerConnectionsHref = () =>
    providerConnectionsHrefForInstallReturn(currentInstallReturnPath());

  const providerConnectionOwnershipLabel = (
    ownership: ProviderCredentialOwnership,
  ) =>
    ownership === "takos_provided"
      ? t("conn.ownership.takosProvided")
      : t("conn.ownership.ownKey");
  const providerConnectionLabel = (connection: ProviderConnection) =>
    `${connection.displayName || connection.providerSource} (${providerConnectionOwnershipLabel(connection.ownership)})`;

  const canonicalProvider = (provider: string) => provider.toLowerCase().trim();
  const providerTail = (provider: string) => {
    const normalized = canonicalProvider(provider);
    return normalized.split("/").at(-1) ?? normalized;
  };
  const sameProviderFamily = (
    requiredProvider: string,
    connectionProvider: string,
  ) => {
    const required = canonicalProvider(requiredProvider);
    const connection = canonicalProvider(connectionProvider);
    if (required === connection) return true;
    return providerTail(required) === providerTail(connection);
  };

  const readyProviderConnections = () =>
    (providerConnections.latest ?? []).filter(
      (connection) => connection.status === "ready",
    );
  const connectionMatchesOwnershipOptions = (
    connection: ProviderConnection,
    ownershipOptions: readonly ProviderCredentialOwnership[],
  ) => ownershipOptions.includes(connection.ownership);
  const providerConnectionsForProvider = (
    provider: string,
    ownershipOptions: readonly ProviderCredentialOwnership[],
  ) =>
    readyProviderConnections().filter(
      (connection) =>
        connectionMatchesOwnershipOptions(connection, ownershipOptions) &&
        sameProviderFamily(provider, connection.providerSource),
    );
  const providerNeedsConnection = (row: ProviderConnectionRow) =>
    providerConnectionsForProvider(row.provider, row.ownershipOptions)
      .length === 0;
  const needsCloudCredential = () =>
    compatibility() !== null && providerRows().some(providerNeedsConnection);

  const defaultConnectionForProvider = (
    provider: string,
    ownershipOptions: readonly ProviderCredentialOwnership[],
    _resourceTypes: readonly string[],
  ): string => {
    const candidates = providerConnectionsForProvider(
      provider,
      ownershipOptions,
    );
    return candidates[0]?.id ?? "";
  };

  const ownershipOptionsForProvider = (
    provider: CapsuleCompatibilityProvider,
  ): readonly ProviderCredentialOwnership[] =>
    provider.ownershipOptions.length > 0
      ? provider.ownershipOptions
      : ["own_key"];

  const rowsFromCompatibility = (
    result: CapsuleCompatibilityResult,
  ): ProviderConnectionRow[] =>
    result.providers
      .filter((provider) => provider.allowed)
      .flatMap((provider) => {
        const aliases = provider.aliases.length > 0 ? provider.aliases : [""];
        const ownershipOptions = ownershipOptionsForProvider(provider);
        const resourceTypes = result.resources
          .filter(
            (resource) =>
              resource.allowed &&
              resource.type
                .toLowerCase()
                .startsWith(`${providerTail(provider.source)}_`),
          )
          .map((resource) => resource.type);
        return aliases.map((alias) => ({
          provider: provider.source,
          alias,
          connectionId: defaultConnectionForProvider(
            provider.source,
            ownershipOptions,
            resourceTypes,
          ),
          ownershipOptions,
          resourceTypes,
        }));
      });

  const updateProviderRow = (
    index: number,
    patch: Partial<ProviderConnectionRow>,
  ) =>
    setProviderRows((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  const providerConnectionError = (): string | null => {
    for (const row of providerRows()) {
      const candidates = providerConnectionsForProvider(
        row.provider,
        row.ownershipOptions,
      );
      if (!row.connectionId.trim()) {
        return t("new.providers.errorConnection", {
          provider: row.provider,
        });
      }
      if (
        !candidates.some((connection) => connection.id === row.connectionId)
      ) {
        return t("new.providers.errorConnection", {
          provider: row.provider,
        });
      }
    }
    return null;
  };

  const providerConnectionsPayload =
    (): InstallationProviderConnectionBindings =>
      providerRows().map((row) => ({
        provider: row.provider,
        ...(row.alias ? { alias: row.alias } : {}),
        connectionId: row.connectionId,
      }));

  const resetCompatibility = () => {
    setCompatibility(null);
    setProviderRows([]);
    setError(null);
  };

  const pickCatalogEntry = (entry: CatalogEntry) => {
    setGitUrl(entry.git);
    setRef(displayRef(entry.ref));
    setPinnedFullRef(isFullCommitSha(entry.ref) ? entry.ref : null);
    setPath(entry.path);
    setName(entry.suggestedName);
    resetCompatibility();
    setActiveTab("git");
  };

  const canContinue = () =>
    compatibility() !== null &&
    compatibility()?.level !== "unsupported" &&
    providerConnectionError() === null;

  const runCompatibilityCheck = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setCheckingCompatibility(true);
    setError(null);
    setSyncRequired(false);
    setStepSource("running");
    setStepSync("running");
    setStepInstall("idle");
    setStepPlan("idle");
    try {
      const result = await checkCapsuleCompatibility({
        spaceId: spaceId()!,
        gitUrl: gitUrl().trim(),
        ref: effectiveRef(),
        path: path().trim() || ".",
        name: name().trim(),
        installConfigId: selectedInstallConfigId(),
      });
      if (result.sourceId) {
        setCreatedSourceId(result.sourceId);
      }
      setStepSource("done");
      setStepSync("done");
      setProviderRows(rowsFromCompatibility(result));
      setCompatibility(result);
    } catch (err) {
      const apiError = err instanceof ControlApiError ? err : undefined;
      if (apiError?.isSourceSyncRequired) {
        setStepSource("done");
        setStepSync("error");
        setSyncRequired(true);
      } else {
        setStepSource("error");
        setStepSync("idle");
      }
      setError(
        apiError?.isSourceSyncRequired
          ? t("new.error.syncPending")
          : (apiError?.message ?? String(err)),
      );
    } finally {
      setCheckingCompatibility(false);
    }
  };

  const runFlow = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!canContinue()) {
      setError(providerConnectionError() ?? t("new.proceedHint"));
      return;
    }
    setBusy(true);
    setError(null);
    setSyncRequired(false);
    const space = spaceId()!;
    try {
      // Step 1 — create Source (skip if a previous attempt already created it).
      let sourceId = createdSourceId();
      if (!sourceId) {
        setStepSource("running");
        const result = await createSource({
          spaceId: space,
          name: name().trim(),
          url: gitUrl().trim(),
          defaultRef: effectiveRef(),
          defaultPath: path().trim() || ".",
        });
        sourceId = result.source.id;
        setCreatedSourceId(sourceId);
        setStepSource("done");
      } else {
        setStepSource("done");
      }

      // Step 2 — sync the Source to resolve an immutable snapshot. When the
      // compatibility check already created and synced the Source, reuse that
      // snapshot instead of adding a second source_sync run.
      if (stepSync() !== "done") {
        setStepSync("running");
        await syncSource(sourceId);
        await waitForLatestSourceSnapshot(sourceId);
        setStepSync("done");
      } else {
        setStepSync("done");
      }

      // Step 3 — create the current compatibility record bound to the chosen
      // service-side config. Public UI presents this as Capsule creation.
      setStepInstall("running");
      const installation = await createInstallation({
        spaceId: space,
        name: name().trim(),
        environment: "production",
        sourceId,
        installConfigId:
          compatibility()?.installConfigId ?? selectedInstallConfigId(),
      });
      await putInstallationProviderConnectionSet(
        installation.id,
        providerConnectionsPayload(),
      );
      setStepInstall("done");

      // Step 4 — create the first plan Run, then jump to the run screen.
      setStepPlan("running");
      const planEnvelope = await planInstallation(installation.id);
      setStepPlan("done");
      const runId = extractRunId(planEnvelope);
      navigate(runId ? `/runs/${runId}` : "/");
    } catch (err) {
      const apiError = err instanceof ControlApiError ? err : undefined;
      if (apiError?.isSourceSyncRequired) {
        setSyncRequired(true);
        setError(t("new.error.syncPending"));
      } else {
        setError(apiError?.message ?? String(err));
      }
      if (stepPlan() === "running") setStepPlan("error");
      else if (stepInstall() === "running") setStepInstall("error");
      else if (stepSync() === "running") setStepSync("error");
      else if (stepSource() === "running") setStepSource("error");
    } finally {
      setBusy(false);
    }
  };

  const stepIcon = (s: StepState): string =>
    s === "done" ? "✓" : s === "error" ? "✕" : s === "running" ? "…" : "·";
  const stepClass = (s: StepState): string =>
    s === "running"
      ? "is-active"
      : s === "done"
        ? "is-done"
        : s === "error"
          ? "is-error"
          : "";

  const gitFields = () => (
    <>
      <FormField label={t("new.git.url")}>
        <Input
          id="new-capsule-git-url"
          name="gitUrl"
          type="text"
          value={gitUrl()}
          onInput={(e) => {
            setGitUrl(e.currentTarget.value);
            resetCompatibility();
          }}
          placeholder="https://github.com/owner/repo.git"
          autocomplete="off"
          spellcheck={false}
        />
      </FormField>

      <div class="wb-form-row">
        <FormField label={t("new.git.ref")}>
          <Input
            id="new-capsule-ref"
            name="ref"
            type="text"
            value={ref()}
            onInput={(e) => {
              setPinnedFullRef(null);
              setRef(e.currentTarget.value);
              resetCompatibility();
            }}
            placeholder="main"
            autocomplete="off"
            spellcheck={false}
          />
        </FormField>
        <FormField label={t("new.git.path")}>
          <Input
            id="new-capsule-path"
            name="path"
            type="text"
            value={path()}
            onInput={(e) => {
              setPath(e.currentTarget.value);
              resetCompatibility();
            }}
            placeholder="."
            autocomplete="off"
            spellcheck={false}
          />
        </FormField>
      </div>
    </>
  );

  return (
    <AppShell>
      <PageHeader
        title={t("new.title")}
        subtitle={t("new.subtitle")}
        actions={
          <Button variant="ghost" href="/">
            {t("app.backToList")}
          </Button>
        }
      />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Download size={28} />}
            title={t("space.select")}
            message={t("space.selectMessage")}
          />
        }
      >
        {/* tab strip: examples | git url */}
        <nav class="tg-tabs" aria-label="Add method">
          <button
            type="button"
            class="tg-tab"
            classList={{ active: activeTab() === "catalog" }}
            onClick={() => setActiveTab("catalog")}
          >
            {t("new.tab.catalog")}
          </button>
          <button
            type="button"
            class="tg-tab"
            classList={{ active: activeTab() === "git" }}
            onClick={() => setActiveTab("git")}
          >
            {t("new.tab.git")}
          </button>
        </nav>

        <Show when={activeTab() === "catalog"}>
          <Card>
            <CardHeader
              title={t("new.tab.catalog")}
              subtitle={t("new.catalog.intro")}
            />
            <ul class="av-catalog">
              <For each={CATALOG}>
                {(entry) => (
                  <li class="av-catalog-item">
                    <div class="av-catalog-text">
                      <span class="av-catalog-name">
                        {entry.name[locale()]}
                      </span>
                      <span class="av-catalog-desc">
                        {entry.description[locale()]}
                      </span>
                      <code class="av-catalog-src">
                        {entry.git}
                        {entry.path !== "." ? ` // ${entry.path}` : ""}
                      </code>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      onClick={() => pickCatalogEntry(entry)}
                    >
                      {t("new.catalog.select")}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Card>
        </Show>

        <Show when={activeTab() === "git"}>
          <Card>
            <CardHeader title={t("new.tab.git")} />
            <CardSection>
              {/* Link-seeded landing: say WHERE the values came from, and that
                  confirmation is still required — the fields stay editable. */}
              <Show when={prefill}>
                <p class="wb-summary-line" role="note">
                  {t("new.deeplink.summary", {
                    capsule: capsuleNameFromUrl(gitUrl() || prefill!.git),
                  })}
                </p>
              </Show>
              <Show when={!compatibility()}>
                <p class="wb-note" role="note">
                  {t("new.managed.notice")}
                </p>
              </Show>
              <Show when={needsCloudCredential()}>
                <p class="wb-note" role="note">
                  {t("new.managed.needCredential")}{" "}
                  <A href={providerConnectionsHref()} class="link">
                    {t("new.managed.connectFirst")}
                  </A>
                </p>
              </Show>
              <details class="wb-disclosure">
                <summary>{t("new.managed.byoTitle")}</summary>
                <p class="wb-note">
                  {t("new.managed.byoBody")}{" "}
                  <A href={providerConnectionsHref()} class="link">
                    {t("new.managed.byoLink")}
                  </A>
                </p>
              </details>

              <form
                class="wb-install-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canContinue()) void runFlow();
                  else void runCompatibilityCheck();
                }}
              >
                {gitFields()}

                <FormField label={t("new.name")}>
                  <Input
                    id="new-capsule-name"
                    name="name"
                    type="text"
                    value={name()}
                    onInput={(e) => {
                      setName(e.currentTarget.value);
                      resetCompatibility();
                    }}
                    placeholder="my-app"
                    autocomplete="off"
                    spellcheck={false}
                  />
                </FormField>

                <Show when={!configs.loading && configList().length === 0}>
                  <p class="wb-error" role="alert">
                    {t("new.error.configMissing")}
                  </p>
                </Show>

                <Show when={compatibility()}>
                  {(result) => (
                    <Card>
                      <CardSection>
                        <div class="wb-compat-head">
                          <h3 class="tg-card-title">{t("new.compat.title")}</h3>
                          <Badge tone={compatibilityTone(result().level)}>
                            {compatibilityLabel(result().level)}
                          </Badge>
                        </div>
                        <p class="wb-compat-summary">{result().summary}</p>
                        <Show when={result().diagnostics.length > 0}>
                          <ul class="wb-diagnostics">
                            <For each={result().diagnostics}>
                              {(diagnostic) => (
                                <li
                                  class={`wb-diagnostic wb-diagnostic-${diagnostic.severity}`}
                                >
                                  {diagnostic.message}
                                  <Show when={diagnostic.detail}>
                                    {(detail) => (
                                      <span class="muted"> — {detail()}</span>
                                    )}
                                  </Show>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </CardSection>
                    </Card>
                  )}
                </Show>

                <Show when={compatibility()}>
                  <section class="wb-inline-panel">
                    <div class="wb-compat-head">
                      <h3 class="tg-card-title">{t("new.providers.title")}</h3>
                    </div>
                    <p class="wb-note">{t("new.providers.subtitle")}</p>
                    <Show
                      when={providerRows().length > 0}
                      fallback={
                        <p class="wb-note">{t("new.providers.noneRequired")}</p>
                      }
                    >
                      <div class="wb-provider-grid">
                        <For each={providerRows()}>
                          {(row, index) => {
                            const options = () =>
                              providerConnectionsForProvider(
                                row.provider,
                                row.ownershipOptions,
                              );
                            return (
                              <div class="wb-provider-row">
                                <div class="wb-provider-meta">
                                  <code>{row.provider}</code>
                                  <Show when={row.alias}>
                                    <span class="muted">
                                      {t("new.providers.alias", {
                                        alias: row.alias,
                                      })}
                                    </span>
                                  </Show>
                                </div>
                                <Select
                                  id={`provider-connection-${index()}`}
                                  name={`providerConnection:${row.provider}:${row.alias ?? "default"}`}
                                  value={row.connectionId}
                                  onChange={(e) =>
                                    updateProviderRow(index(), {
                                      connectionId: e.currentTarget.value,
                                    })
                                  }
                                >
                                  <option value="">
                                    {t("new.providers.selectConnection")}
                                  </option>
                                  <For each={options()}>
                                    {(connection) => (
                                      <option value={connection.id}>
                                        {providerConnectionLabel(connection)}
                                      </option>
                                    )}
                                  </For>
                                </Select>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                      <Show when={providerConnectionError()}>
                        {(m) => (
                          <p class="wb-error" role="alert">
                            {m()}
                          </p>
                        )}
                      </Show>
                      <p class="wb-note">
                        <A href={providerConnectionsHref()} class="link">
                          {t("new.providers.manageConnections")}
                        </A>
                      </p>
                    </Show>
                  </section>
                </Show>

                <div class="wb-form-actions">
                  <Show
                    when={compatibility()}
                    fallback={
                      <Button
                        variant="primary"
                        type="submit"
                        busy={checkingCompatibility()}
                        disabled={checkingCompatibility() || busy()}
                      >
                        {checkingCompatibility()
                          ? t("new.compat.checking")
                          : t("new.compat.check")}
                      </Button>
                    }
                  >
                    <Button
                      variant="secondary"
                      type="button"
                      busy={checkingCompatibility()}
                      disabled={checkingCompatibility() || busy()}
                      onClick={() => void runCompatibilityCheck()}
                    >
                      {checkingCompatibility()
                        ? t("new.compat.checking")
                        : t("new.compat.recheck")}
                    </Button>
                    <Button
                      variant="primary"
                      type="submit"
                      busy={busy()}
                      disabled={busy() || !canContinue()}
                    >
                      {t("new.proceed")}
                    </Button>
                  </Show>
                  <Show when={syncRequired() && !busy()}>
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => void runFlow()}
                    >
                      {t("common.retry")}
                    </Button>
                  </Show>
                </div>

                <Show when={error()}>
                  {(m) => (
                    <p class="wb-error" role="alert">
                      {m()}
                    </p>
                  )}
                </Show>
              </form>

              <Show when={stepSource() !== "idle"} fallback={null}>
                <ol class="wb-steps">
                  <li class={`wb-step ${stepClass(stepSource())}`}>
                    <span class="wb-step-icon">{stepIcon(stepSource())}</span>
                    {t("new.step.register")}
                  </li>
                  <li class={`wb-step ${stepClass(stepSync())}`}>
                    <span class="wb-step-icon">{stepIcon(stepSync())}</span>
                    {t("new.step.sync")}
                  </li>
                  <li class={`wb-step ${stepClass(stepInstall())}`}>
                    <span class="wb-step-icon">{stepIcon(stepInstall())}</span>
                    {t("new.step.create")}
                  </li>
                  <li class={`wb-step ${stepClass(stepPlan())}`}>
                    <span class="wb-step-icon">{stepIcon(stepPlan())}</span>
                    {t("new.step.plan")}
                  </li>
                </ol>
              </Show>
            </CardSection>
          </Card>
        </Show>
      </Show>
    </AppShell>
  );
}
