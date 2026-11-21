/**
 * `/new`: the Store and an app's page while it is not installed yet
 * (TASK-0115).
 *
 * - `/new` lists the Store.
 * - `/new?tcsBase&tcsListing…`, `/new?git=…` (and `/install`, `/store`, which
 *   forward here) show one app, not installed. Opening it creates nothing.
 * - 「インストール」 starts one install attempt and opens the one install
 *   screen: everything the install needs, visible at once, while the
 *   coordinator reads the repository and makes the Plan. Its id joins the
 *   URL (`installPlan=gip_…`) so a reload reopens the same attempt, read-only
 *   until the person acts again.
 * - Nothing applies before 「インストール」; the install then finishes
 *   on the same screen, which offers 「開く」 and the app's own page.
 */
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { Navigate, useLocation, useNavigate } from "@solidjs/router";
import { ArrowLeft, ChevronDown, ExternalLink } from "lucide-solid";
import { matchingInstalledApps, normalizeInstallConfigSourceUrl, type GitInstallPlan } from "takosumi-contract";
import Page from "../account/components/auth/Page.tsx";
import AppFace from "../../components/AppFace.tsx";
import { Button, FormField, Input, Select, Spinner } from "../../components/ui/index.ts";
import { StoreBrowser, type StoreCatalogCache } from "../store/StoreBrowser.tsx";
import { StoreGallery, StoreOfferDetails, StoreRating } from "../store/StoreListingDetails.tsx";
import { buildNewQuery } from "../store/store-link.ts";
import { locale, t } from "../../i18n/index.ts";
import { listConnections, listInstalledApps } from "../../lib/control-api.ts";
import { capsuleNameFromUrl, GIT_INSTALL_ENTRY, hasInstallPrefillParams, parseInstallPrefill } from "../../lib/install-link.ts";
import { installReturnPathFromPrefill } from "../../lib/install-return-context.ts";
import {
  appendAppHandoff,
  appHandoffFromSearch,
  appHandoffProductLabel,
  createAppHandoffConnectHref,
} from "../../lib/app-handoff.ts";
import { fetchTcsListing, tcsListingIdentity, type TcsListing } from "../../lib/tcs-client.ts";
import { listAuthorizedUiSurfaces } from "../../lib/ui-surface-interfaces.ts";
import { appPageHref } from "../../lib/app-links.ts";
import { providerConnectionDisplayName } from "../../lib/provider-connections.ts";
import { readyOrUndefined } from "../../lib/resource-read.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { InstallScreen } from "./InstallSheet.tsx";
import AppPhoneSection from "../app/AppPhoneSection.tsx";
import {
  attemptProblemKey,
  INSTALL_SCREEN_STAGES,
  installAttemptId,
  legacyCapsuleLocator,
  repositoryLabel,
  versionLabel,
  withInstallAttempt,
  withoutInstallContext,
} from "./install-attempt.ts";
import {
  useInstallAttempt,
  type InstallAttempt,
} from "./use-install-attempt.ts";
import "./install-view.css";

function storeBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

/** A Store hand-off (`tcsBase` + `tcsListing`), read-only presentation input. */
function storeHandoff(search: string): { readonly base: string; readonly listingId: string } | undefined {
  const params = new URLSearchParams(search);
  const base = storeBase(params.get("tcsBase") ?? undefined);
  const listingId = params.get("tcsListing")?.trim();
  if (!base || !listingId || !/^[A-Za-z0-9_.:@/-]{1,256}$/u.test(listingId)) return undefined;
  return { base, listingId };
}

/** The most recent selection lets its page render while the detail is read. */
let pickedListing: TcsListing | undefined;

type StoreHandoff = NonNullable<ReturnType<typeof storeHandoff>>;

function matchesStoreRepository(listing: TcsListing, expectedGit?: string): boolean {
  if (!expectedGit) return true;
  try {
    return tcsListingIdentity(listing.source) === tcsListingIdentity({ url: expectedGit });
  } catch {
    return false;
  }
}

function cachedListing(handoff: StoreHandoff, expectedGit?: string): TcsListing | undefined {
  const picked = pickedListing;
  return picked && picked.id === handoff.listingId && storeBase(picked.primaryServer) === handoff.base &&
      matchesStoreRepository(picked, expectedGit)
    ? picked
    : undefined;
}

async function readListing(handoff: StoreHandoff, expectedGit?: string): Promise<TcsListing | null> {
  // A product can be repointed after the card or a shared link was made.
  // Don't replace that link's Git source with the new one.
  const picked = cachedListing(handoff, expectedGit);
  try {
    const listing = await fetchTcsListing(handoff.base, handoff.listingId, AbortSignal.timeout(8000));
    if (!listing || listing.id !== handoff.listingId ||
      !matchesStoreRepository(listing, expectedGit ?? picked?.source.url)) return null;
    return { ...listing, source: picked?.source ?? listing.source, primaryServer: handoff.base };
  } catch (error) {
    if (picked) return picked;
    throw error;
  }
}

const SCREEN_READ_ATTEMPTS = 10;
const SCREEN_READ_DELAY_MS = 3_000;

export default function InstallView() {
  return (
    <Page title={t("installStore.title")}>
      {(session) => <InstallRoute principalId={session.subject} />}
    </Page>
  );
}

function InstallRoute(props: { readonly principalId: string }) {
  const location = useLocation();
  const catalogCache: StoreCatalogCache = {};
  const namesApp = () =>
    Boolean(
      installAttemptId(location.search) ||
        storeHandoff(location.search) ||
        parseInstallPrefill(withoutInstallContext(location.search)),
    );
  return (
    <Switch fallback={
      <StorePage
        catalogCache={catalogCache}
        rejectedInstallLink={hasInstallPrefillParams(withoutInstallContext(location.search))}
      />
    }>
      <Match when={legacyCapsuleLocator(location.search)}>
        {(capsuleId) => <Navigate href={appPageHref(capsuleId())} />}
      </Match>
      <Match when={namesApp()}>
        <AppInstallPage principalId={props.principalId} />
      </Match>
      <Match when={`${location.pathname}${location.search}` === GIT_INSTALL_ENTRY}>
        <GitInstallPage />
      </Match>
    </Switch>
  );
}

// --- The Store -------------------------------------------------------------------

function StorePage(props: {
  readonly rejectedInstallLink: boolean;
  readonly catalogCache: StoreCatalogCache;
}) {
  const navigate = useNavigate();
  // Selecting a listing reflects it into the URL, so back and share work.
  const choose = (listing: TcsListing) => {
    pickedListing = listing;
    navigate(`/new?${buildNewQuery(listing)}`);
  };
  return (
    <div class="iv-page iv-browse-page">
      <header class="iv-hero iv-page-heading">
        <h1>{t("installStore.title")}</h1>
        <a class="iv-git-link" href={GIT_INSTALL_ENTRY}>{t("installStore.fromGit")}</a>
      </header>
      <Show when={props.rejectedInstallLink}>
        <div class="iv-error" role="alert" data-testid="install-link-refusal">
          <p>{t("installStore.invalidInstallLink")}</p>
        </div>
      </Show>
      <section class="iv-catalogue iv-catalogue-browse" aria-label={t("installStore.browseTitle")}>
        <StoreBrowser
          locale={locale()}
          catalogCache={props.catalogCache}
          onConfigure={choose}
          onSelectListing={choose}
          showSourceControls={true}
          showSortControl={true}
        />
      </section>
    </div>
  );
}

// The same provider-free example as the standalone quickstart.
const standaloneExample = installReturnPathFromPrefill({
  git: "https://github.com/tako0614/takosumi.git",
  ref: "v2.0.0",
  path: "examples/opentofu-basic",
  name: "OpenTofu sample",
});

function GitInstallPage() {
  const navigate = useNavigate();
  const [gitUrl, setGitUrl] = createSignal("");
  const [invalid, setInvalid] = createSignal(false);
  return (
    <div class="iv-page iv-browse-page iv-git-entry">
      <header class="iv-hero iv-page-heading"><h1>{t("installStore.fromGit")}</h1></header>
      <form class="iv-form" onSubmit={(event) => {
        event.preventDefault();
        const path = installReturnPathFromPrefill({ git: gitUrl() });
        if (!path) {
          setInvalid(true);
          return;
        }
        navigate(path);
      }}>
        <FormField label={t("installStore.sourceUrl")} error={invalid() ? t("installStore.invalidSource") : undefined}>
          <Input
            value={gitUrl()}
            onInput={(event) => { setGitUrl(event.currentTarget.value); setInvalid(false); }}
            placeholder="https://github.com/example/service.git"
            autocomplete="off"
            spellcheck={false}
          />
        </FormField>
        <Button type="submit">{t("installStore.continue")}</Button>
      </form>
      <Show when={standaloneExample}>
        {(href) => <p class="iv-muted iv-git-example">
          <a href={href()}>{t("installStore.tryExample")}</a>
        </p>}
      </Show>
    </div>
  );
}

// --- One app, not installed yet ------------------------------------------------

function AppInstallPage(props: { readonly principalId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const handoff = createMemo(() => appHandoffFromSearch(location.search));
  const prefill = createMemo(() => parseInstallPrefill(withoutInstallContext(location.search)));
  const store = createMemo(() => storeHandoff(location.search), undefined, {
    equals: (a, b) => a?.base === b?.base && a?.listingId === b?.listingId,
  });
  const storeGit = createMemo(() => prefill()?.git);
  // The listing is presentation only (name, icon, description, its module).
  const [listing] = createResource(
    () => {
      const source = store();
      return source ? { ...source, expectedGit: storeGit() } : false;
    },
    ({ expectedGit, ...source }) => readListing(source, expectedGit),
  );
  const [ref, setRef] = createSignal(prefill()?.ref ?? "");
  const [sourceAuth, setSourceAuth] = createSignal("");
  createEffect(on(() => `${prefill()?.git ?? ""}|${store()?.listingId ?? ""}`, () => {
    setRef(prefill()?.ref ?? "");
    setSourceAuth("");
  }, { defer: true }));
  const [completed, setCompleted] = createSignal<{
    readonly capsuleId: string;
    readonly url?: string;
    /** The bounded read for the app's screen is over (with or without one). */
    readonly settled?: boolean;
  }>();
  let disposed = false;
  onCleanup(() => { disposed = true; });

  /** Where to land once the attempt is gone: the same app, never a new start. */
  const leaveSearch = (plan: GitInstallPlan): string => {
    const remaining = withInstallAttempt(location.search, undefined);
    if (store() || prefill()) return remaining;
    const path = installReturnPathFromPrefill({
      git: plan.source.url,
      ref: plan.source.ref === "HEAD" ? "" : plan.source.ref,
      sourcePath: plan.source.path,
      path: plan.options.modulePath ?? "",
      name: capsuleNameFromUrl(plan.source.url),
    });
    return path ? (appendAppHandoff(path, handoff()) ?? path).replace(/^\/new/u, "") : "";
  };

  const attempt = useInstallAttempt({
    principalId: props.principalId,
    attemptId: () => installAttemptId(location.search),
    onStarted: (attemptId) =>
      navigate(`${location.pathname}${withInstallAttempt(location.search, attemptId)}`, { replace: true }),
    onLeft: (plan) => navigate(`${location.pathname}${leaveSearch(plan)}`, { replace: true }),
    // The page's own link says whether this app came from a Store listing,
    // also when the attempt is opened again.
    fromStore: () => Boolean(store()),
  });
  const plan = () => attempt.response()?.installPlan;
  const fromStore = () => Boolean(store());
  // `.latest` throws once a read failed; the listing is optional presentation.
  const resolvedListing = () => {
    const source = store();
    if (!source || listing.error) return undefined;
    const fetched = listing.latest;
    if (fetched === null) return null;
    return fetched?.id === source.listingId && fetched.primaryServer === source.base &&
        matchesStoreRepository(fetched, storeGit())
      ? fetched
      : undefined;
  };
  const listed = () => {
    const source = store();
    const fetched = resolvedListing();
    // Null means the Store removed or repointed the listing.
    return fetched === null || !source ? undefined : fetched ?? cachedListing(source, storeGit());
  };
  const listingFailed = (): boolean => Boolean(listing.error || (store() && listing.state === "ready" && listing.latest === null));
  const selectedGitUrl = () => listed()?.source.url ?? prefill()?.git;
  const sourceMismatch = createMemo(() => {
    const selected = selectedGitUrl();
    const current = plan();
    return Boolean(selected && current &&
      normalizeInstallConfigSourceUrl(selected) !== normalizeInstallConfigSourceUrl(current.source.url));
  });
  createEffect(on(sourceMismatch, (mismatch) => {
    if (mismatch) {
      attempt.finish();
      setCompleted(undefined);
    }
  }));
  const gitUrl = () => (sourceMismatch() ? selectedGitUrl() : plan()?.source.url ?? selectedGitUrl()) ?? "";
  const [installedApps, { refetch: refetchInstalledApps }] = createResource(
    () => ({ workspaceId: currentWorkspaceId() || undefined }),
    (scope) => listInstalledApps(scope.workspaceId),
  );
  const existingApps = createMemo(() => matchingInstalledApps(
    !installedApps.loading && !installedApps.error ? installedApps()?.installedApps ?? [] : [],
    {
      url: gitUrl(),
      path: listed()?.source.path || [prefill()?.sourcePath, prefill()?.path]
        .filter((part) => part && part !== ".").join("/") || ".",
    },
  ));
  const installedLabel = () => existingApps().length === 1
    ? t("installStore.installed")
    : t("installStore.installedCount", { count: existingApps().length });

  // Private repositories: a personal or operator-provided Git connection may
  // read the source. Legacy Workspace connections remain usable as well.
  // Offered only before Install, so only read then.
  const [connections] = createResource(
    () => attempt.view().stage === "candidate" && !fromStore()
      ? { workspaceId: currentWorkspaceId() || undefined }
      : false,
    (scope) => listConnections(scope.workspaceId),
  );
  const sourceConnections = () =>
    (readyOrUndefined(connections) ?? []).filter(
      (connection) =>
        connection.status === "verified" &&
        (connection.kind === "source_git_https_token" || connection.kind === "source_git_ssh_key"),
    );

  const title = () => {
    const selected = listed();
    const text = selected?.name?.[locale()]?.trim() || selected?.suggestedName;
    return text || prefill()?.name || (gitUrl() ? capsuleNameFromUrl(gitUrl()) : "");
  };
  const description = () => {
    const text = listed()?.description?.[locale()]?.trim();
    return text && text !== title() ? text : undefined;
  };
  const publisher = () => {
    const publisher = listed()?.publisher;
    return publisher?.displayName?.trim() || publisher?.handle?.trim();
  };
  const version = () => {
    const current = sourceMismatch() ? undefined : plan();
    if (!current) return versionLabel(ref()) ?? (ref() === "HEAD" ? "HEAD" : undefined);
    const resolved = attempt.resolvedVersion();
    return resolved && resolved.commit === current.source.ref
      ? `${resolved.tag} · ${resolved.commit.slice(0, 7)}`
      : versionLabel(current.source.ref) ?? current.source.ref;
  };

  const install = () => {
    if (sourceMismatch()) return;
    if (installedApps.state !== "ready") return;
    void attempt.start(
      {
        url: gitUrl(),
        ref: ref(),
        sourcePath: prefill()?.sourcePath ?? ".",
        modulePath: listed()?.source.path ?? prefill()?.path ?? "",
        ...(sourceAuth() ? { authConnectionId: sourceAuth() } : {}),
      },
      { fromStore: fromStore() },
    );
  };

  /**
   * The install finished on this screen: offer 「開く」 once the app's screen
   * is known (an app that sent the person here gets them back with it), and
   * the app's own page.
   */
  const finish = async (capsuleId: string) => {
    if (completed()?.capsuleId === capsuleId) return;
    const workspaceId = plan()?.workspaceId || currentWorkspaceId() || undefined;
    clearCapsuleListCache(workspaceId);
    attempt.finish();
    setCompleted({ capsuleId });
    if (!workspaceId) {
      setCompleted({ capsuleId, settled: true });
      return;
    }
    for (let index = 0; index < SCREEN_READ_ATTEMPTS; index += 1) {
      try {
        const screens = await listAuthorizedUiSurfaces(workspaceId, { capsuleId });
        if (disposed) return;
        const url = screens[0]?.url;
        if (url) {
          setCompleted({ capsuleId, url, settled: true });
          return;
        }
      } catch {
        // Retried within the bounded read; never shown as a launchable screen.
      }
      await new Promise((resolve) => setTimeout(resolve, SCREEN_READ_DELAY_MS));
      if (disposed || completed()?.capsuleId !== capsuleId) return;
    }
    setCompleted({ capsuleId, settled: true });
  };

  const stage = () => attempt.view().stage;
  // A Plan that failed after the sheet stays on the screen with the answers.
  const onScreen = () =>
    (INSTALL_SCREEN_STAGES.has(stage()) && stage() !== "starting") ||
    (stage() === "failed" && attempt.sheet() !== undefined);
  // Entering the install screen, a problem or the end moves focus to its
  // heading, so keyboard and screen reader users land where the page
  // changed. Moving within the screen keeps focus where the person types.
  const place = () => (sourceMismatch() ? "source-mismatch" : completed() ? "complete" : onScreen() ? "screen" : stage());
  createEffect(on(place, (current, previous) => {
    if (previous === undefined || current === previous) return;
    queueMicrotask(() => {
      if (disposed) return;
      document.querySelector<HTMLElement>("main [data-stage-heading]")?.focus({ preventScroll: true });
    });
  }, { defer: true }));

  return (
    <div class="iv-page iv-configure-page" data-install-state={stage()}>
      <a class="iv-back-link" href={fromStore() ? "/new" : GIT_INSTALL_ENTRY}>
        <ArrowLeft size={18} aria-hidden="true" />{t(fromStore() ? "installStore.back" : "installStore.fromGit")}
      </a>
      <article class="iv-app-surface" aria-labelledby="iv-app-title">
        <header class="iv-app-detail" data-testid="install-app-header">
          <AppFace name={title()} iconUrl={listed()?.iconUrl} class="iv-app-icon" monogramFrameClass="iv-app-monogram" />
          <div class="iv-app-intro">
            <h1 id="iv-app-title">{title() || t("common.loading")}</h1>
            <Show when={publisher()}>{(name) => <span class="iv-app-publisher">{name()}</span>}</Show>
            <Show when={fromStore()}><StoreRating rating={listed()?.rating} locale={locale()} showEmpty /></Show>
            <Show when={description()}>{(text) => <p>{text()}</p>}</Show>
          </div>
        </header>

        <Show when={handoff()}>
          {(context) => (
            <aside class="iv-handoff" role="status">
              <strong>{appHandoffProductLabel(context().product)} {t("installStore.title")}</strong>
              <p>{context().returnUri}</p>
            </aside>
          )}
        </Show>

        <Show when={listingFailed()}>
          <div class="iv-error" role="alert">{t("installStore.listingUnavailable")}</div>
        </Show>

        <Show when={sourceMismatch() ? undefined : completed()} fallback={
          <Switch>
            <Match when={sourceMismatch()}>
              <section class="iv-workbench" data-testid="install-source-mismatch" role="alert">
                <h2 data-stage-heading tabindex="-1">{t("installStore.invalidInstallLink")}</h2>
                <Button href={`${location.pathname}${withInstallAttempt(location.search, undefined)}`} variant="primary">
                  {t("installStore.continue")}
                </Button>
              </section>
            </Match>
            <Match when={stage() === "candidate" || stage() === "starting"}>
              <section class="iv-workbench iv-start" data-testid="install-start">
                <Show when={attempt.error()}>{(message) => <div class="iv-error" role="alert">{message()}</div>}</Show>
                <form
                  class="iv-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    install();
                  }}
                >
                  <Show when={existingApps().length > 0}>
                    <div class="iv-existing-apps" data-testid="install-existing-apps">
                      <p class="iv-muted">{installedLabel()}</p>
                      <div class="iv-action-row">
                        <For each={existingApps()}>{(app) => {
                          const label = () => app.displayName?.[locale()] || title();
                          return (
                            <>
                              <Button variant="primary" href={appPageHref(app.capsuleId)} aria-label={`${t("installStore.open")}: ${label()}`}>
                                {t("installStore.open")}<Show when={existingApps().length > 1}> · {label()}</Show>
                              </Button>
                              <Button variant="secondary" href={appPageHref(app.capsuleId, "version")} aria-label={`${t(app.updateAvailable ? "app.version.update" : "installStore.manageVersion")}: ${label()}`}>
                                {t(app.updateAvailable ? "app.version.update" : "installStore.manageVersion")}
                              </Button>
                            </>
                          );
                        }}</For>
                      </div>
                    </div>
                  </Show>
                  <Show when={installedApps.error || (!installedApps.loading && installedApps()?.complete === false)}>
                    <p class="iv-error" role="alert">{t("installStore.installedReadFailed")}</p>
                    <Button type="button" variant="secondary" onClick={() => void refetchInstalledApps()}>{t("common.retry")}</Button>
                  </Show>
                  <Show when={sourceConnections().length > 0}>
                    <FormField label={t("installStore.sourceAuth")}>
                      <Select value={sourceAuth()} onChange={(event) => setSourceAuth(event.currentTarget.value)}>
                        <option value="">{t("installStore.publicSource")}</option>
                        <For each={sourceConnections()}>
                          {(connection) => (
                            <option value={connection.id}>{providerConnectionDisplayName(connection)}</option>
                          )}
                        </For>
                      </Select>
                    </FormField>
                  </Show>
                  <div class="iv-decision">
                    <div class="iv-action-row">
                      <Button
                        type="submit"
                        variant={existingApps().length > 0 ? "secondary" : "primary"}
                        size="lg"
                        busy={attempt.mutating() === "start"}
                        disabled={!gitUrl() || installedApps.state !== "ready" || (store() !== undefined && listing.loading)}
                      >
                        {existingApps().length > 0 ? t("installStore.installAnother") : t("installStore.install")}
                      </Button>
                    </div>
                    <Show when={existingApps().length > 0}>
                      <p class="iv-start-hint">{t("installStore.installAnotherHint")}</p>
                    </Show>
                  </div>
                  <details class="iv-disclosure iv-choice iv-version-choice iv-start-version" data-testid="install-source-fields">
                    <summary>
                      <span>{t("installStore.versionLabel")}</span>
                      <strong>{ref() === "HEAD" && fromStore() ? t("installStore.developmentPreview") : ref() ? versionLabel(ref()) ?? t("installStore.defaultBranch") : t(fromStore() ? "installStore.latest" : "installStore.defaultBranch")}</strong>
                      <ChevronDown size={16} aria-hidden="true" />
                    </summary>
                    <div class="iv-choice-content">
                      <Show when={fromStore()}>
                        <div class="iv-action-row" role="group" aria-label={t("installStore.versionLabel")}>
                          <Button type="button" size="sm" variant={ref().trim() ? "ghost" : "secondary"} aria-pressed={!ref().trim()}
                            onClick={() => setRef("")}>{t("installStore.latest")}</Button>
                          <Button type="button" size="sm" variant={ref() === "HEAD" ? "secondary" : "ghost"} aria-pressed={ref() === "HEAD"}
                            onClick={() => setRef("HEAD")}>{t("installStore.developmentPreview")}</Button>
                        </div>
                      </Show>
                      <FormField
                        label={t("installStore.sourceRef")}
                        hint={fromStore() ? t("installStore.sourceRefStableHint") : t("installStore.sourceRefHint")}
                      >
                        <Input
                          value={ref()}
                          placeholder={fromStore() ? t("installStore.sourceRefStable") : undefined}
                          spellcheck={false}
                          onInput={(event) => setRef(event.currentTarget.value)}
                        />
                      </FormField>
                    </div>
                  </details>
                </form>
              </section>
            </Match>
            <Match when={stage() === "loading"}>
              <section class="iv-workbench iv-centered" role="status" aria-live="polite" data-testid="install-loading">
                <Spinner size={24} />
                <h2 data-stage-heading tabindex="-1">{t("common.loading")}</h2>
              </section>
            </Match>
            <Match when={onScreen()}>
              <InstallScreen
                attempt={attempt}
                workspaceId={plan()?.workspaceId || currentWorkspaceId() || undefined}
                fromStore={fromStore()}
                storeModulePath={listed()?.source.path}
                onDone={(capsuleId) => void finish(capsuleId)}
              />
            </Match>
            <Match when={true}>
              <AttemptProblem
                attempt={attempt}
                onReinstall={() => {
                  const current = plan();
                  navigate(
                    `${location.pathname}${current ? leaveSearch(current) : withInstallAttempt(location.search, undefined)}`,
                    { replace: true },
                  );
                }}
              />
            </Match>
          </Switch>
        }>
          {(done) => (<>
            <section class="iv-workbench iv-centered" role="status" data-testid="install-complete">
              <h2 data-stage-heading tabindex="-1">{t("installStore.completeTitle")}</h2>
              <p>{handoff() ? t("installStore.completeHint") : t("installStore.completeOpenHint")}</p>
              <div class="iv-action-row">
                <Show
                  when={handoff()}
                  fallback={
                    <Show when={done().url} fallback={<Show when={!done().settled}><Spinner size={18} /></Show>}>
                      {(url) => (
                        <Button
                          href={url()}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="primary"
                          icon={<ExternalLink size={16} />}
                        >
                          {t("installStore.open")}
                        </Button>
                      )}
                    </Show>
                  }
                >
                  <Show when={createAppHandoffConnectHref(handoff(), done().url)} fallback={
                    <Show when={!done().settled}><Spinner size={18} /></Show>
                  }>
                    {(href) => (
                      <Button href={href()} variant="primary">
                        {t("run.appHandoff.open", { app: appHandoffProductLabel(handoff()!.product) })}
                      </Button>
                    )}
                  </Show>
                </Show>
                <Button
                  href={appPageHref(done().capsuleId)}
                  variant={done().settled && !done().url ? "primary" : "secondary"}
                >
                  {t("installStore.manageApp")}
                </Button>
              </div>
            </section>
            <Show when={!handoff() && done().url}>
              {(url) => <AppPhoneSection url={url()} appName={title()} />}
            </Show>
          </>)}
        </Show>
        <Show when={fromStore() && (stage() === "candidate" || stage() === "starting") && listed()}>
          {(item) => (
            <div class="iv-store-product">
              <StoreGallery gallery={item().gallery} appName={title()} locale={locale()} />
              <StoreOfferDetails listing={item()} locale={locale()} />
            </div>
          )}
        </Show>
        <Show when={gitUrl()}>
          <details class="iv-app-about">
            <summary>{t("installStore.provenance")}<ChevronDown size={16} aria-hidden="true" /></summary>
            <p class="iv-provenance" data-testid="install-provenance">
              <code>{repositoryLabel(gitUrl())}</code>
              <Show when={version()}>{(text) => <> · <code>{text()}</code></>}</Show>
            </p>
          </details>
        </Show>
      </article>
    </div>
  );
}

/** A stopped attempt: why, and the one way forward. */
function AttemptProblem(props: { readonly attempt: InstallAttempt; readonly onReinstall: () => void }) {
  const view = () => props.attempt.view();
  const diagnostic = () => props.attempt.response()?.installPlan.diagnostic;
  const code = () => view().invalidated ?? view().retryCode ?? diagnostic()?.code;
  const title = () => {
    switch (view().stage) {
      case "retry":
        return t("installStore.problem.retryTitle");
      case "invalidated":
        return t("installStore.problem.expiredTitle");
      case "discarded":
        return t("installStore.problem.discardedTitle");
      case "unavailable":
        return t("installStore.recoveryUnverified");
      default:
        return t("installStore.problem.failedTitle");
    }
  };
  const text = () =>
    view().stage === "unavailable"
      ? t("installStore.recoveryUnverifiedHint")
      : view().stage === "discarded" && !code()
        ? t("installStore.problem.discarded")
        : t(attemptProblemKey(code()));
  return (
    <section class="iv-workbench" data-testid="install-attempt-problem" data-install-stage={view().stage}>
      <div class="iv-section-head" role="alert">
        <h2 data-stage-heading tabindex="-1">{title()}</h2>
        <p>{props.attempt.error() || text()}</p>
        <Show when={!props.attempt.error() && attemptProblemKey(code()) === "installStore.problem.generic" && diagnostic()?.message}>
          {(message) => <p class="iv-muted">{message()}</p>}
        </Show>
      </div>
      <div class="iv-action-row">
        <Switch>
          <Match when={view().primary === "retry"}>
            <Button type="button" variant="primary" disabled={view().primaryBlocked} onClick={() => props.attempt.resume()}>
              {t("installStore.problem.retry")}
            </Button>
          </Match>
          <Match when={view().primary === "restart"}>
            <Button
              type="button"
              variant="primary"
              busy={props.attempt.mutating() === "restart"}
              disabled={view().primaryBlocked}
              onClick={() => void props.attempt.restart()}
            >
              {t("installStore.problem.restart")}
            </Button>
          </Match>
          <Match when={view().primary === "reinstall"}>
            <Button type="button" variant="primary" onClick={props.onReinstall}>
              {t("installStore.problem.reinstall")}
            </Button>
          </Match>
          <Match when={view().primary === "reload"}>
            <Button type="button" variant="primary" busy={props.attempt.loading()} onClick={() => void props.attempt.reload()}>
              {t("common.retry")}
            </Button>
          </Match>
        </Switch>
        <Show when={view().canDiscard}>
          <Button
            type="button"
            variant="ghost"
            busy={props.attempt.mutating() === "discard"}
            onClick={() => void props.attempt.discard()}
          >
            {t("installStore.discard")}
          </Button>
        </Show>
        <Show when={view().stage === "unavailable" || view().stage === "discarded"}>
          <Button variant="ghost" href="/new">{t("installStore.chooseAnother")}</Button>
        </Show>
        {/* A failed Plan's reason and logs are on its run's page. */}
        <Show when={view().stage === "failed" ? props.attempt.response()?.installPlan.planRunId : undefined}>
          {(runId) => (
            <Button variant="ghost" href={`/runs/${encodeURIComponent(runId())}`} icon={<ExternalLink size={16} />}>
              {t("installStore.runDetails")}
            </Button>
          )}
        </Show>
      </div>
    </section>
  );
}
