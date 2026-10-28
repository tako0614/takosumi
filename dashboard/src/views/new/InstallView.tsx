/**
 * `/new`: the Store and an app's page while it is not installed yet
 * (TASK-0115 Phase 3b).
 *
 * - `/new` lists the Store and this person's unfinished installs.
 * - `/new?tcsBase&tcsListing…`, `/new?git=…` (and `/install`, `/store`, which
 *   forward here) show one app, not installed. Opening it creates nothing.
 * - 「インストール」 starts one install attempt; the coordinator reads the
 *   repository and the page follows its `userAction`. Its id joins the URL
 *   (`installPlan=gip_…`) so a reload reopens the same attempt, read-only
 *   until the person acts again.
 * - Nothing applies before 「許可してインストール」 in the review; after it the
 *   page moves to the installed app's own page.
 */
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { Navigate, useLocation, useNavigate } from "@solidjs/router";
import { ArrowLeft, PackagePlus } from "lucide-solid";
import type { GitInstallPlan, GitInstallPlanResponse, GitInstallPlanUserAction } from "takosumi-contract";
import Page from "../account/components/auth/Page.tsx";
import AppFace from "../../components/AppFace.tsx";
import { Button, FormField, Input, Select, Spinner } from "../../components/ui/index.ts";
import { StoreBrowser } from "../store/StoreBrowser.tsx";
import { buildNewQuery } from "../store/store-link.ts";
import { locale, t } from "../../i18n/index.ts";
import {
  getCapsuleApp,
  listConnections,
  listOpenGitInstallAttempts,
} from "../../lib/control-api.ts";
import { capsuleNameFromUrl, isSafeHttpsGitUrl, parseInstallPrefill } from "../../lib/install-link.ts";
import { installReturnPathFromPrefill } from "../../lib/install-return-context.ts";
import {
  appendAppHandoff,
  appHandoffFromSearch,
  appHandoffProductLabel,
  createAppHandoffConnectHref,
} from "../../lib/app-handoff.ts";
import { fetchTcsListing, type TcsListing } from "../../lib/tcs-client.ts";
import { listAuthorizedUiSurfaces } from "../../lib/ui-surface-interfaces.ts";
import { appPageHref, installAttemptHref } from "../../lib/app-links.ts";
import { providerConnectionDisplayName } from "../../lib/provider-connections.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import InstallExecution from "./InstallExecution.tsx";
import { InstallSheet, ModuleChooser } from "./InstallSheet.tsx";
import {
  appNameFromText,
  attemptProblemKey,
  installAttemptId,
  legacyCapsuleLocator,
  openAttemptStatusKey,
  repositoryLabel,
  versionLabel,
  withInstallAttempt,
  withoutInstallContext,
} from "./install-attempt.ts";
import {
  discardInstallAttempt,
  installErrorMessage,
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

/**
 * The listing the person just picked in the Store, kept in memory only so its
 * page shows it without reading it again. A shared or reloaded link reads the
 * listing from its Store instead.
 */
let pickedListing: TcsListing | undefined;

function readListing(handoff: { readonly base: string; readonly listingId: string }) {
  const picked = pickedListing;
  return picked && picked.id === handoff.listingId && storeBase(picked.primaryServer) === handoff.base
    ? Promise.resolve(picked)
    : fetchTcsListing(handoff.base, handoff.listingId);
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
  const namesApp = () =>
    Boolean(
      installAttemptId(location.search) ||
        storeHandoff(location.search) ||
        parseInstallPrefill(withoutInstallContext(location.search)),
    );
  return (
    <Switch fallback={<StorePage principalId={props.principalId} />}>
      <Match when={legacyCapsuleLocator(location.search)}>
        {(capsuleId) => <Navigate href={appPageHref(capsuleId())} />}
      </Match>
      <Match when={namesApp()}>
        <AppInstallPage principalId={props.principalId} />
      </Match>
    </Switch>
  );
}

// --- The Store -------------------------------------------------------------------

function StorePage(props: { readonly principalId: string }) {
  const navigate = useNavigate();
  const [gitUrl, setGitUrl] = createSignal("");
  const [gitError, setGitError] = createSignal<string>();
  // Selecting a listing reflects it into the URL, so back and share work.
  const choose = (listing: TcsListing) => {
    pickedListing = listing;
    navigate(`/new?${buildNewQuery(listing)}`);
  };
  return (
    <main class="iv-page iv-browse-page" data-install-state="not-installed">
      <header class="iv-hero iv-page-heading"><h1>{t("installStore.title")}</h1></header>
      <OpenAttempts principalId={props.principalId} />
      <section class="iv-catalogue iv-catalogue-browse" aria-label={t("installStore.browseTitle")}>
        <StoreBrowser
          locale={locale()}
          onConfigure={choose}
          onSelectListing={choose}
          showSourceControls={true}
          showSortControl={true}
        />
        <details class="iv-manual">
          <summary>{t("installStore.manual")}</summary>
          <form
            class="iv-manual-row"
            onSubmit={(event) => {
              event.preventDefault();
              const url = gitUrl().trim();
              const path = isSafeHttpsGitUrl(url) ? installReturnPathFromPrefill({ git: url }) : undefined;
              if (!path) {
                setGitError(t("installStore.invalidSource"));
                return;
              }
              setGitError(undefined);
              navigate(path);
            }}
          >
            <Input
              value={gitUrl()}
              onInput={(event) => setGitUrl(event.currentTarget.value)}
              placeholder="https://github.com/example/service.git"
              aria-label={t("installStore.sourceUrl")}
              spellcheck={false}
            />
            <Button type="submit" variant="secondary">{t("installStore.continue")}</Button>
          </form>
          <Show when={gitError()}>{(message) => <p class="iv-muted" role="alert">{message()}</p>}</Show>
        </details>
      </section>
    </main>
  );
}

/** This person's unfinished installs here: each can continue or be thrown away. */
function OpenAttempts(props: { readonly principalId: string }) {
  const [attempts, { mutate, refetch }] = createResource(
    () => currentWorkspaceId() || false,
    (workspaceId) => listOpenGitInstallAttempts(workspaceId),
  );
  const [busy, setBusy] = createSignal<string>();
  const [rowError, setRowError] = createSignal<{ readonly id: string; readonly message: string }>();
  const mine = () =>
    (attempts.error ? [] : (attempts.latest ?? [])).filter(
      (entry) => entry.installPlan.createdBy === props.principalId,
    );
  const discard = async (entry: GitInstallPlanResponse) => {
    const plan = entry.installPlan;
    if (busy()) return;
    setBusy(plan.id);
    setRowError(undefined);
    try {
      // A newer generation than the list's is read again before discarding.
      await discardInstallAttempt(plan.id, plan.generation);
      clearCapsuleListCache(plan.workspaceId);
      clearCurrentStateVersionCache(plan.workspaceId);
      clearDashboardOverviewCache(plan.workspaceId);
      mutate((current) => current?.filter((item) => item.installPlan.id !== plan.id));
    } catch (cause) {
      setRowError({ id: plan.id, message: installErrorMessage(cause) });
      // Show the list as it is now.
      void refetch();
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Show when={mine().length > 0}>
      <section class="iv-open-attempts" data-testid="install-open-attempts" aria-labelledby="iv-open-title">
        <h2 id="iv-open-title">{t("installStore.open.title")}</h2>
        <p class="iv-muted">{t("installStore.open.hint")}</p>
        <ul>
          <For each={mine()}>
            {(entry) => (
              <li data-install-plan-id={entry.installPlan.id}>
                <div class="iv-open-attempt-text">
                  <strong>{entry.installPlan.capsule.name}</strong>
                  <span>
                    {repositoryLabel(entry.installPlan.source.url)}
                    <Show when={versionLabel(entry.installPlan.source.ref)}>{(version) => <> · {version()}</>}</Show>
                  </span>
                  <span class="iv-open-attempt-status">{t(openAttemptStatusKey(entry))}</span>
                </div>
                <div class="iv-open-attempt-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    href={installAttemptHref(entry.installPlan.id)}
                  >
                    {t("installStore.continue")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    busy={busy() === entry.installPlan.id}
                    disabled={busy() !== undefined}
                    onClick={() => void discard(entry)}
                  >
                    {t("installStore.discard")}
                  </Button>
                </div>
                <Show when={rowError()?.id === entry.installPlan.id ? rowError()?.message : undefined}>
                  {(message) => <p class="iv-muted" role="alert">{message()}</p>}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

// --- One app, not installed yet ------------------------------------------------

function AppInstallPage(props: { readonly principalId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const handoff = createMemo(() => appHandoffFromSearch(location.search));
  const prefill = createMemo(() => parseInstallPrefill(withoutInstallContext(location.search)));
  const store = createMemo(() => storeHandoff(location.search));
  // The listing is presentation only (name, icon, description, its module).
  const [listing] = createResource(
    () => store() ?? false,
    (handoffSource) => readListing(handoffSource),
  );
  const [ref, setRef] = createSignal(prefill()?.ref ?? "");
  const [sourceAuth, setSourceAuth] = createSignal("");
  createEffect(on(() => `${prefill()?.git ?? ""}|${store()?.listingId ?? ""}`, () => {
    setRef(prefill()?.ref ?? "");
    setSourceAuth("");
  }, { defer: true }));
  const [completed, setCompleted] = createSignal<{ readonly capsuleId: string; readonly url?: string }>();
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
      name: plan.capsule.name,
    });
    return path ? (appendAppHandoff(path, handoff()) ?? path).replace(/^\/new/u, "") : "";
  };

  const attempt = useInstallAttempt({
    principalId: props.principalId,
    attemptId: () => installAttemptId(location.search),
    onStarted: (attemptId) =>
      navigate(`${location.pathname}${withInstallAttempt(location.search, attemptId)}`, { replace: true }),
    onLeft: (plan) => navigate(`${location.pathname}${leaveSearch(plan)}`, { replace: true }),
  });
  const plan = () => attempt.response()?.installPlan;
  const fromStore = () => Boolean(store());
  // `.latest` throws once a read failed; the listing is optional presentation.
  const listed = () => (listing.error ? undefined : (listing.latest ?? undefined));
  const listingFailed = (): boolean => Boolean(listing.error);
  const gitUrl = () => plan()?.source.url ?? listed()?.source.url ?? prefill()?.git ?? "";

  // Private repositories: an existing Git connection may read the source.
  // Offered only before Install, so only read then.
  const [connections] = createResource(
    () => (attempt.view().stage === "candidate" && !fromStore() && currentWorkspaceId()) || false,
    (workspaceId) => listConnections(workspaceId),
  );
  const sourceConnections = () =>
    (connections.error ? [] : (connections.latest ?? [])).filter(
      (connection) =>
        connection.scope === "workspace" &&
        connection.status === "verified" &&
        (connection.kind === "source_git_https_token" || connection.kind === "source_git_ssh_key"),
    );

  const title = () => {
    const selected = listed();
    const text = selected?.name?.[locale()]?.trim() || selected?.suggestedName;
    return text || plan()?.capsule.name || prefill()?.name || (gitUrl() ? capsuleNameFromUrl(gitUrl()) : "");
  };
  const description = () => {
    const text = listed()?.description?.[locale()]?.trim();
    return text && text !== title() ? text : t("installStore.appDescription");
  };
  const version = () => {
    const current = plan();
    if (!current) return versionLabel(ref());
    const resolved = attempt.resolvedVersion();
    return resolved && resolved.commit === current.source.ref
      ? `${resolved.tag} · ${resolved.commit.slice(0, 7)}`
      : versionLabel(current.source.ref);
  };

  const install = () =>
    void attempt.start(
      {
        url: gitUrl(),
        ref: ref(),
        sourcePath: prefill()?.sourcePath ?? ".",
        modulePath: listed()?.source.path ?? prefill()?.path ?? "",
        name: prefill()?.name
          ? appNameFromText(prefill()!.name!)
          : appNameFromText(listed()?.suggestedName ?? ""),
        ...(sourceAuth() ? { authConnectionId: sourceAuth() } : {}),
      },
      { fromStore: fromStore() },
    );

  const finish = async (capsuleId: string) => {
    const workspaceId = plan()?.workspaceId ?? currentWorkspaceId();
    clearCapsuleListCache(workspaceId);
    clearCurrentStateVersionCache(workspaceId);
    clearDashboardOverviewCache(workspaceId);
    const returnTo = handoff();
    if (!returnTo) {
      navigate(appPageHref(capsuleId), { replace: true });
      return;
    }
    // An app that sent the person here gets them back with the new screen.
    setCompleted({ capsuleId });
    for (let index = 0; index < SCREEN_READ_ATTEMPTS; index += 1) {
      try {
        const screens = await listAuthorizedUiSurfaces(workspaceId, { capsuleId });
        if (disposed) return;
        const url = screens[0]?.url;
        if (url) {
          setCompleted({ capsuleId, url });
          return;
        }
      } catch {
        // Retried within the bounded read; never shown as a launchable screen.
      }
      await new Promise((resolve) => setTimeout(resolve, SCREEN_READ_DELAY_MS));
      if (disposed || completed()?.capsuleId !== capsuleId) return;
    }
  };

  const stage = () => attempt.view().stage;
  // Each new stage moves focus to its own heading, so keyboard and screen
  // reader users land where the page changed.
  createEffect(on(stage, (current, previous) => {
    if (previous === undefined || current === previous) return;
    queueMicrotask(() => {
      if (disposed) return;
      document.querySelector<HTMLElement>("main [data-stage-heading]")?.focus({ preventScroll: true });
    });
  }, { defer: true }));

  return (
    <main class="iv-page iv-configure-page" data-install-state={stage()}>
      <header class="iv-app-detail" data-testid="install-app-header">
        <AppFace name={title()} iconUrl={listed()?.iconUrl} class="iv-app-icon" />
        <div>
          <h1>{title() || t("common.loading")}</h1>
          <p>{description()}</p>
          <Show when={gitUrl()}>
            <p class="iv-provenance" data-testid="install-provenance">
              <span>{t("installStore.provenance")}</span> <code>{repositoryLabel(gitUrl())}</code>
              <Show when={version()}>{(text) => <> · <code>{text()}</code></>}</Show>
            </p>
          </Show>
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

      <Show when={completed()} fallback={
        <Switch>
          <Match when={stage() === "candidate"}>
            <section class="iv-workbench iv-start" data-testid="install-start">
              <Show when={attempt.error()}>{(message) => <div class="iv-error" role="alert">{message()}</div>}</Show>
              <form
                class="iv-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  install();
                }}
              >
                <div class="iv-action-row iv-start-actions">
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    busy={attempt.mutating() === "start"}
                    disabled={!gitUrl() || (store() !== undefined && listing.loading)}
                    icon={<PackagePlus size={18} />}
                  >
                    {t("installStore.install")}
                  </Button>
                  <Button variant="ghost" href="/new" icon={<ArrowLeft size={16} />}>
                    {t("installStore.back")}
                  </Button>
                </div>
                <p class="iv-start-hint">{t("installStore.startHint")}</p>
                <div class="iv-fields iv-source-fields" data-testid="install-source-fields">
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
                </div>
              </form>
            </section>
          </Match>
          <Match when={stage() === "loading"}>
            <section class="iv-workbench iv-centered" role="status" aria-live="polite" data-testid="install-loading">
              <Spinner size={24} />
              <h2 data-stage-heading tabindex="-1">{t("common.loading")}</h2>
            </section>
          </Match>
          <Match when={stage() === "starting" || stage() === "reading" || stage() === "paused"}>
            <ReadingCard attempt={attempt} />
          </Match>
          <Match when={stage() === "choose_module" ? attempt.response()!.userAction : undefined}>
            {(action) => (
              <ModuleChooser
                attempt={attempt}
                action={action() as Extract<GitInstallPlanUserAction, { kind: "choose_module" }>}
              />
            )}
          </Match>
          <Match when={stage() === "provide_inputs" ? attempt.response()!.userAction : undefined}>
            {(action) => (
              <InstallSheet
                attempt={attempt}
                action={action() as Extract<GitInstallPlanUserAction, { kind: "provide_inputs" }>}
                workspaceId={plan()?.workspaceId ?? currentWorkspaceId()}
              />
            )}
          </Match>
          <Match when={stage() === "review" ? attempt.response()!.userAction : undefined}>
            {(action) => (
              <InstallReview
                attempt={attempt}
                action={action() as Extract<GitInstallPlanUserAction, { kind: "review_run" }>}
                onDone={(capsuleId) => void finish(capsuleId)}
              />
            )}
          </Match>
          <Match when={stage() !== "candidate"}>
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
        {(done) => (
          <section class="iv-workbench iv-centered" role="status" data-testid="install-complete">
            <h2 data-stage-heading tabindex="-1">{t("installStore.completeTitle")}</h2>
            <p>{t("installStore.completeHint")}</p>
            <div class="iv-action-row">
              <Show when={handoff() && createAppHandoffConnectHref(handoff(), done().url)} fallback={
                <Show when={!done().url}><Spinner size={18} /></Show>
              }>
                {(href) => (
                  <Button href={href()} variant="primary">
                    {t("run.appHandoff.open", { app: appHandoffProductLabel(handoff()!.product) })}
                  </Button>
                )}
              </Show>
              <Button href={appPageHref(done().capsuleId)} variant="secondary">{t("installStore.manageApp")}</Button>
            </div>
          </section>
        )}
      </Show>
    </main>
  );
}

/** The coordinator works on its own: reading the repository or planning. */
function ReadingCard(props: { readonly attempt: InstallAttempt }) {
  const view = () => props.attempt.view();
  const phase = () => props.attempt.response()?.installPlan.phase;
  const hint = () => {
    switch (phase()) {
      case "compiling_install":
      case "analyzing_compatibility":
        return t("installStore.reading.analyzing");
      case "creating_capsule":
      case "planning":
        return t("installStore.reading.planning");
      default:
        return t("installStore.reading.source");
    }
  };
  return (
    <section
      class="iv-workbench iv-centered"
      role="status"
      aria-live="polite"
      data-testid="install-reading"
      data-install-phase={phase()}
    >
      <Show when={view().stage !== "paused"}><Spinner size={24} /></Show>
      <h2 data-stage-heading tabindex="-1">
        {view().stage === "paused" ? t("installStore.reading.pausedTitle") : t("installStore.reading.title")}
      </h2>
      <p>{view().stage === "paused" ? t("installStore.reading.pausedHint") : hint()}</p>
      <Show when={props.attempt.error()}>{(message) => <div class="iv-error" role="alert">{message()}</div>}</Show>
      <div class="iv-action-row">
        <Show when={view().primary === "continue"}>
          <Button type="button" variant="primary" disabled={view().primaryBlocked} onClick={() => props.attempt.resume()}>
            {t("installStore.continue")}
          </Button>
        </Show>
        <Show when={view().stage !== "starting"}>
          <Button
            type="button"
            variant="ghost"
            busy={props.attempt.mutating() === "discard"}
            disabled={!view().canDiscard}
            onClick={() => void props.attempt.discard()}
          >
            {t("installStore.discard")}
          </Button>
        </Show>
      </div>
    </section>
  );
}

/** The Plan Run is ready: what the app creates, its cost, and the one apply click. */
function InstallReview(props: {
  readonly attempt: InstallAttempt;
  readonly action: Extract<GitInstallPlanUserAction, { kind: "review_run" }>;
  readonly onDone: (capsuleId: string) => void;
}) {
  // A reopened review first asks the app where it stands (GET
  // /capsules/:id/app): an apply already running is followed instead of
  // offering Allow and install again, and an app already installed opens its
  // own page. A failed read falls back to the review; the Run routes still
  // refuse a second apply.
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
  return (
    <section
      class="iv-workbench iv-sheet"
      data-testid="install-review"
      data-stage-heading
      tabindex="-1"
      aria-label={t("installStore.reviewTitle")}
    >
      <Show when={props.attempt.error()}>{(message) => <div class="iv-error" role="alert">{message()}</div>}</Show>
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
        <p>{text()}</p>
        <Show when={attemptProblemKey(code()) === "installStore.problem.generic" && diagnostic()?.message}>
          {(message) => <p class="iv-muted">{message()}</p>}
        </Show>
      </div>
      <Show when={props.attempt.error()}>{(message) => <div class="iv-error" role="alert">{message()}</div>}</Show>
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
      </div>
    </section>
  );
}
