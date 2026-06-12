/**
 * Add an app (`/new`) — catalog + Git URL, one flow.
 *
 * Two entry shapes, identical install path:
 *   - カタログ: curated first-party / official capsules (src/catalog.ts).
 *     Picking one pre-fills the Git tab.
 *   - Git URL: the raw source form (the developer power path), also the
 *     landing target of the worker's external `/install?git=…` link (redirected
 *     here query-intact) and the packed `source=git::…` form.
 *
 * The flow (ported from the legacy InstallFromGitView) runs four resumable
 * steps — createSource → syncSource → createInstallation → plan — and lands on
 * `/runs/:id`. A 409 source_sync_required surfaces a humane retry instead of a
 * raw error. The managed-default nudge logic is unchanged: only warn about
 * credentials when the operator default CANNOT cover the apply AND the Space
 * has no connection of its own.
 */
import "../../styles/wave-b.css";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { Download } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId } from "../control/space-state.ts";
import { CATALOG, type CatalogEntry } from "../../catalog.ts";
import {
  checkCapsuleCompatibility,
  ControlApiError,
  createInstallation,
  createSource,
  extractRunId,
  type ProviderBindings,
  type CapsuleCompatibilityLevel,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  getManagedDefaultStatus,
  listConnections,
  listInstallConfigs,
  listSpaces,
  planInstallation,
  putDeploymentProfile,
  syncSource,
  waitForLatestSourceSnapshot,
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
  type Tone,
} from "../../components/ui/index.ts";

/** Reads `git` / `ref` / `path` deep-link prefill (query, packed, or hash). */
function readPrefill(): {
  git: string;
  ref: string;
  path: string;
} {
  const out = { git: "", ref: "", path: "" };
  if (typeof location === "undefined") return out;
  const apply = (params: URLSearchParams) => {
    const packed = parsePackedInstallSource(params.get("source"));
    out.git = params.get("git") ?? packed?.git ?? out.git;
    out.ref = params.get("ref") ?? packed?.ref ?? out.ref;
    out.path = params.get("path") ?? packed?.path ?? out.path;
  };
  apply(new URLSearchParams(location.search));
  // Legacy hash deep-link form: /#/install?git=…
  const hash = location.hash;
  const q = hash.indexOf("?");
  if (q !== -1) apply(new URLSearchParams(hash.slice(q + 1)));
  return out;
}

function parsePackedInstallSource(
  source: string | null,
): { git: string; ref: string; path: string } | undefined {
  const prefix = "git::";
  if (!source?.startsWith(prefix)) return undefined;
  const body = source.slice(prefix.length);
  const queryStart = body.indexOf("?");
  const beforeQuery = queryStart === -1 ? body : body.slice(0, queryStart);
  const query = queryStart === -1 ? "" : body.slice(queryStart + 1);
  const marker = findModulePathMarker(beforeQuery);
  const git = marker === -1 ? beforeQuery : beforeQuery.slice(0, marker);
  const path = marker === -1 ? "" : beforeQuery.slice(marker + 2);
  const params = new URLSearchParams(query);
  return {
    git,
    ref: params.get("ref") ?? "",
    path,
  };
}

function findModulePathMarker(value: string): number {
  const scheme = value.indexOf("://");
  const start = scheme === -1 ? 0 : scheme + "://".length;
  return value.indexOf("//", start);
}

type StepState = "idle" | "running" | "done" | "error";

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

export default function NewAppView() {
  return <Page title={t("new.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const navigate = useNavigate();

  const prefill = readPrefill();
  const cameFromDeepLink = prefill.git.trim().length > 0;
  const [activeTab, setActiveTab] = createSignal<"catalog" | "git">(
    cameFromDeepLink ? "git" : "catalog",
  );
  const [gitUrl, setGitUrl] = createSignal(prefill.git);
  const [ref, setRef] = createSignal(prefill.ref || "main");
  const [path, setPath] = createSignal(prefill.path || ".");
  const [name, setName] = createSignal("");
  const [installConfigId, setInstallConfigId] = createSignal("");
  const [compatibility, setCompatibility] =
    createSignal<CapsuleCompatibilityResult | null>(null);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);

  onMount(() => {
    if (!name() && prefill.git) {
      const guess = guessNameFromUrl(prefill.git);
      if (guess) setName(guess);
    }
  });

  const capsuleDisplayName = () => {
    const url = gitUrl().trim();
    if (!url) return "";
    return guessNameFromUrl(url) || url;
  };

  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [spaces] = createResource(listSpaces);
  const spaceHandle = () => {
    const id = spaceId();
    if (!id) return "";
    const match = (spaces() ?? []).find((s) => s.id === id);
    return match ? `@${match.handle}` : id;
  };
  const [configs] = createResource(spaceId, listInstallConfigs);
  const [managedDefaults] = createResource(spaceId, getManagedDefaultStatus);
  const [connections] = createResource(spaceId, listConnections);
  // Fail to the safe side while loading: never claim managed coverage we have
  // not verified, never show a false "no connection" nag before the list is in.
  const managedAvailable = () => {
    if (managedDefaults.loading || managedDefaults.error) return false;
    return managedDefaults.latest?.available === true;
  };
  const hasSpaceConnection = () => {
    if (connections.loading || connections.error) return true;
    const list = connections.latest;
    if (list === undefined) return true;
    return list.some((connection) => connection.status !== "revoked");
  };
  const needsCloudCredential = () =>
    !managedAvailable() && !hasSpaceConnection();

  const configList = createMemo<readonly InstallConfig[]>(
    () => configs() ?? [],
  );
  const ensureConfigSelected = () => {
    const list = configList();
    if (list.length === 0) return list;
    const current = installConfigId();
    if (!current || !list.some((config) => config.id === current)) {
      setInstallConfigId(list[0]!.id);
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

  const deploymentProfileBindings = (): ProviderBindings => [];

  const resetCompatibility = () => {
    setCompatibility(null);
    setError(null);
  };

  const pickCatalogEntry = (entry: CatalogEntry) => {
    setGitUrl(entry.git);
    setRef(entry.ref);
    setPath(entry.path);
    setName(entry.suggestedName);
    resetCompatibility();
    setActiveTab("git");
  };

  const canContinue = () =>
    compatibility() !== null && compatibility()?.level !== "unsupported";

  const runCompatibilityCheck = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setCheckingCompatibility(true);
    setError(null);
    try {
      const result = await checkCapsuleCompatibility({
        spaceId: spaceId()!,
        gitUrl: gitUrl().trim(),
        ref: ref().trim() || "main",
        path: path().trim() || ".",
        name: name().trim(),
        installConfigId: selectedInstallConfigId(),
      });
      if (result.sourceId) {
        setCreatedSourceId(result.sourceId);
        setStepSource("done");
        setStepSync("done");
      }
      setCompatibility(result);
    } catch (err) {
      const apiError = err instanceof ControlApiError ? err : undefined;
      setError(apiError?.message ?? String(err));
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
      setError(t("new.proceedHint"));
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
          defaultRef: ref().trim() || "main",
          defaultPath: path().trim() || ".",
        });
        sourceId = result.source.id;
        setCreatedSourceId(sourceId);
        setStepSource("done");
      } else {
        setStepSource("done");
      }

      // Step 2 — sync the Source to resolve an immutable snapshot.
      setStepSync("running");
      await syncSource(sourceId);
      await waitForLatestSourceSnapshot(sourceId);
      setStepSync("done");

      // Step 3 — create the Installation bound to the chosen InstallConfig.
      setStepInstall("running");
      const installation = await createInstallation({
        spaceId: space,
        name: name().trim(),
        environment: "production",
        sourceId,
        installConfigId:
          compatibility()?.installConfigId ?? selectedInstallConfigId(),
      });
      await putDeploymentProfile(installation.id, deploymentProfileBindings());
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
            type="text"
            value={ref()}
            onInput={(e) => {
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
        {/* tab strip: catalog | git url */}
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
            <CardHeader title={t("new.tab.catalog")} subtitle={t("new.catalog.intro")} />
            <ul class="av-catalog">
              <For each={CATALOG}>
                {(entry) => (
                  <li class="av-catalog-item">
                    <div class="av-catalog-text">
                      <span class="av-catalog-name">{entry.name[locale()]}</span>
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
            <CardHeader
              title={cameFromDeepLink ? t("new.title") : t("new.tab.git")}
            />
            <CardSection>
              <Show when={managedAvailable() && !hasSpaceConnection()}>
                <p class="wb-note" role="note">
                  {t("new.managed.notice")}
                </p>
              </Show>
              <Show when={needsCloudCredential()}>
                <p class="wb-note" role="note">
                  {t("new.managed.needCredential")}{" "}
                  <A href="/space/settings/connections" class="link">
                    {t("new.managed.connectFirst")}
                  </A>
                </p>
              </Show>
              <details class="wb-disclosure">
                <summary>{t("new.managed.byoTitle")}</summary>
                <p class="wb-note">
                  {t("new.managed.byoBody")}{" "}
                  <A href="/space/settings/connections" class="link">
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
                <Show when={cameFromDeepLink} fallback={gitFields()}>
                  <Card>
                    <CardSection>
                      <p class="wb-summary-line">
                        {t("new.deeplink.summary", {
                          capsule: capsuleDisplayName(),
                          space: spaceHandle(),
                        })}
                      </p>
                      <p class="wb-note">{gitUrl()}</p>
                    </CardSection>
                  </Card>

                  <details class="wb-disclosure">
                    <summary>{t("new.deeplink.editSource")}</summary>
                    {gitFields()}
                  </details>
                </Show>

                <FormField label={t("new.name")}>
                  <Input
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

                <div class="wb-form-actions">
                  <Button
                    variant="secondary"
                    type="button"
                    busy={checkingCompatibility()}
                    disabled={checkingCompatibility() || busy()}
                    onClick={() => void runCompatibilityCheck()}
                  >
                    {checkingCompatibility()
                      ? t("new.compat.checking")
                      : t("new.compat.check")}
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    busy={busy()}
                    disabled={busy() || !canContinue()}
                  >
                    {t("new.proceed")}
                  </Button>
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
                  {(m) => <p class="wb-error" role="alert">{m()}</p>}
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

function guessNameFromUrl(url: string): string | undefined {
  return url
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean)
    .pop();
}
