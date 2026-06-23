/**
 * Home (`/`) — the Workspace service list, the dashboard's primary surface.
 *
 * Service launcher over the current compatibility Installation list: open when
 * public outputs expose a launch URL, otherwise show the service details. The
 * control-plane state stays available deeper in the service view.
 */
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ExternalLink, LayoutGrid, Plus, Sparkles } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId, setCurrentSpaceId } from "../../lib/space-state.ts";
import {
  type ControlApiError,
  createSpace,
  getDeployment,
  type Installation,
  type Space,
  listInstallations,
} from "../../lib/control-api.ts";
import {
  effectiveInstallationStatus,
  isVisibleServiceInstallation,
  launchUrlFromOutputs,
  needsAttention,
} from "../../lib/installations-ui.ts";
import { installationStatusLabel, installationTone } from "../../lib/labels.ts";
import { formatDateTime, t } from "../../i18n/index.ts";
import {
  Button,
  PageHeader,
  Skeleton,
  StatusBadge,
  Toast,
} from "../../components/ui/index.ts";
import { createAction } from "../account/lib/action.tsx";

export default function AppListView() {
  return <Page title={t("apps.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const navigate = useNavigate();
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);

  const [installations] = createResource(spaceId, listInstallations);
  const visibleInstallations = createMemo(() =>
    (installations() ?? []).filter(isVisibleServiceInstallation),
  );

  // Launch URL per app, from its current Deployment's public outputs.
  const [launchUrls] = createResource(visibleInstallations, async (list) => {
    const map = new Map<string, string>();
    await Promise.all(
      list
        .filter(
          (inst): inst is Installation & { currentDeploymentId: string } =>
            Boolean(inst.currentDeploymentId),
        )
        .map(async (inst) => {
          try {
            const deployment = await getDeployment(inst.currentDeploymentId);
            const url = launchUrlFromOutputs(deployment.outputsPublic);
            if (url) map.set(inst.id, url);
          } catch {
            // One failing deployment read must not blank the list; that row
            // simply gets no launch link.
          }
        }),
    );
    return map;
  });

  /** Services currently needing attention (error / stale under either model). */
  const attentionCount = createMemo(
    () => visibleInstallations().filter(needsAttention).length,
  );
  const createFirstWorkspace = createAction(async (): Promise<Space> => {
    const space = await createSpace({
      handle: defaultWorkspaceHandle(),
      displayName: t("space.defaultName"),
      type: "personal",
    });
    setCurrentSpaceId(space.id);
    window.dispatchEvent(new Event("takosumi:spaces-changed"));
    navigate("/new");
    return space;
  });

  const showAddServiceAction = createMemo(() => {
    const list = visibleInstallations();
    return Boolean(list && list.length > 0);
  });

  const openDetail = (inst: Installation) =>
    navigate(`/services/${encodeURIComponent(inst.id)}`);

  return (
    <AppShell>
      <PageHeader
        title={t("apps.title")}
        subtitle={t("apps.subtitle")}
        actions={
          showAddServiceAction() ? (
            <div class="av-actions">
              <Button variant="primary" href="/new" icon={<Plus size={16} />}>
                {t("apps.add")}
              </Button>
            </div>
          ) : undefined
        }
      />

      <Show
        when={spaceId()}
        fallback={
          <NoWorkspaceStartPanel
            busy={createFirstWorkspace.busy()}
            error={createFirstWorkspace.error()}
            onCreate={() => void createFirstWorkspace.run()}
          />
        }
      >
        <Show when={attentionCount() > 0}>
          <div class="av-attention" role="status">
            <span>{t("apps.attention", { n: attentionCount() })}</span>
            <Button variant="secondary" size="sm" href="/notifications">
              {t("apps.attentionView")}
            </Button>
          </div>
        </Show>

        <Switch>
          <Match when={installations.loading}>
            <div class="av-service-list">
              <Skeleton variant="row" count={4} />
            </div>
          </Match>
          <Match when={installations.error}>
            <Toast tone="error">
              {t("common.fetchFailed", {
                message: (installations.error as ControlApiError).message,
              })}
            </Toast>
          </Match>
          <Match when={installations()}>
            <Show
              when={visibleInstallations().length === 0}
              fallback={
                <ServiceList
                  installations={visibleInstallations()}
                  launchUrls={launchUrls() ?? new Map()}
                  openDetail={openDetail}
                />
              }
            >
              <WorkspaceStartPanel />
            </Show>
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}

function NoWorkspaceStartPanel(props: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCreate: () => void;
}) {
  return (
    <section class="av-start" aria-label={t("space.start.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("space.start.kicker")}</span>
        <h2 class="av-start-title">{t("space.start.title")}</h2>
        <p class="av-start-sub">{t("space.start.body")}</p>
      </div>
      <Button
        variant="primary"
        type="button"
        busy={props.busy}
        icon={<Plus size={18} />}
        onClick={props.onCreate}
      >
        {props.busy ? t("space.start.creating") : t("space.start.create")}
      </Button>
      <Show when={props.error}>
        {(message) => <Toast tone="error">{message()}</Toast>}
      </Show>
    </section>
  );
}

function ServiceList(props: {
  readonly installations: readonly Installation[];
  readonly launchUrls: ReadonlyMap<string, string>;
  readonly openDetail: (inst: Installation) => void;
}) {
  return (
    <ul class="av-service-grid">
      <For each={props.installations}>
        {(inst) => (
          <li
            class="av-service-card"
            classList={{
              "av-service-card-attention": needsAttention(inst),
            }}
          >
            <button
              type="button"
              class="av-service-main"
              onClick={() => props.openDetail(inst)}
            >
              <span class="av-service-icon" aria-hidden="true">
                <LayoutGrid size={20} />
              </span>
              <div class="av-service-head">
                <span class="av-service-name">{inst.name}</span>
                <StatusBadge
                  status={effectiveInstallationStatus(inst)}
                  label={installationStatusLabel}
                  tone={installationTone}
                />
                <span class="av-service-updated">
                  {t("apps.updated", {
                    date: formatDateTime(inst.updatedAt),
                  })}
                </span>
              </div>
              <div class="av-service-meta">
                <span>{inst.environment}</span>
              </div>
            </button>
            <div class="av-service-actions">
              <Show
                when={props.launchUrls.get(inst.id)}
                fallback={
                  <>
                    <span class="av-service-link-state">
                      {t("apps.noOpenLink")}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => props.openDetail(inst)}
                    >
                      {t("apps.viewDetails")}
                    </Button>
                  </>
                }
              >
                {(url) => (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<ExternalLink size={14} />}
                    href={url()}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t("apps.openApp")}
                  </Button>
                )}
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

function defaultWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

function WorkspaceStartPanel() {
  return (
    <section class="av-start" aria-label={t("apps.start.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("apps.start.kicker")}</span>
        <h2 class="av-start-title">{t("apps.start.titleEmpty")}</h2>
        <p class="av-start-sub">{t("apps.start.bodyEmpty")}</p>
      </div>
      <a href="/new" class="av-start-action">
        <Sparkles size={18} aria-hidden="true" />
        <span>{t("apps.start.optionCatalog")}</span>
      </a>
    </section>
  );
}
