/**
 * Home (`/`) — the Workspace service list, the dashboard's primary surface.
 *
 * Service launcher over the current compatibility Installation list: open when
 * public outputs expose a launch URL, otherwise show the service details. The
 * control-plane state stays available deeper in the service view.
 */
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Boxes, ExternalLink, LayoutGrid, Plus } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId } from "../../lib/space-state.ts";
import {
  type ControlApiError,
  getDeployment,
  getSpaceGraph,
  type Installation,
  listActivity,
  listInstallations,
  type SpaceGraph,
} from "../../lib/control-api.ts";
import {
  effectiveInstallationStatus,
  launchUrlFromOutputs,
  needsAttention,
  staleReasonFromActivity,
} from "../../lib/installations-ui.ts";
import { installationStatusLabel, installationTone } from "../../lib/labels.ts";
import { t } from "../../i18n/index.ts";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
  StatusBadge,
  Toast,
} from "../../components/ui/index.ts";

export default function AppListView() {
  return <Page title={t("apps.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const navigate = useNavigate();
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);

  const [installations] = createResource(spaceId, listInstallations);
  const [graph] = createResource(spaceId, getSpaceGraph);
  const [activity] = createResource(spaceId, (id) => listActivity(id, 100));

  // consumerInstallationId -> [producer names], from the graph edges.
  const dependsOn = createMemo(() => {
    const g: SpaceGraph | undefined = graph();
    const map = new Map<string, string[]>();
    if (!g) return map;
    const nameById = new Map(g.nodes.map((n) => [n.installationId, n.name]));
    for (const edge of g.edges) {
      const producerName =
        nameById.get(edge.producerInstallationId) ??
        edge.producerInstallationId;
      const list = map.get(edge.consumerInstallationId) ?? [];
      list.push(producerName);
      map.set(edge.consumerInstallationId, list);
    }
    return map;
  });

  const staleReasons = createMemo(() => {
    const map = new Map<string, string>();
    for (const event of activity() ?? []) {
      if (
        event.action !== "installation.stale" ||
        event.targetType !== "installation" ||
        map.has(event.targetId)
      ) {
        continue;
      }
      const reason = staleReasonFromActivity(event);
      if (reason) map.set(event.targetId, reason);
    }
    return map;
  });

  // Launch URL per app, from its current Deployment's public outputs.
  const [launchUrls] = createResource(installations, async (list) => {
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
    () => (installations() ?? []).filter(needsAttention).length,
  );

  const deployedCount = createMemo(
    () =>
      (installations() ?? []).filter(
        (inst) => effectiveInstallationStatus(inst) === "active",
      ).length,
  );

  const openDetail = (inst: Installation) =>
    navigate(`/capsules/${encodeURIComponent(inst.id)}`);

  return (
    <AppShell>
      <PageHeader
        title={t("apps.title")}
        subtitle={t("apps.subtitle")}
        actions={
          <div class="av-actions">
            <Button variant="primary" href="/new" icon={<Plus size={16} />}>
              {t("apps.add")}
            </Button>
          </div>
        }
      />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            icon={<Boxes size={28} />}
            title={t("space.select")}
            message={t("space.selectMessage")}
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
            {(list) => (
              <>
                <Show
                  when={list().length === 0}
                  fallback={
                    <>
                      <ServiceLauncherHeader
                        serviceCount={list().length}
                        deployedCount={deployedCount()}
                        attentionCount={attentionCount()}
                      />
                      <ServiceList
                        installations={list()}
                        dependsOn={dependsOn()}
                        staleReasons={staleReasons()}
                        launchUrls={launchUrls() ?? new Map()}
                        openDetail={openDetail}
                      />
                    </>
                  }
                >
                  <WorkspaceStartPanel />
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}

function ServiceList(props: {
  readonly installations: readonly Installation[];
  readonly dependsOn: ReadonlyMap<string, readonly string[]>;
  readonly staleReasons: ReadonlyMap<string, string>;
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
              onClick={() => {
                const url = props.launchUrls.get(inst.id);
                if (url) {
                  window.open(url, "_blank", "noopener,noreferrer");
                  return;
                }
                props.openDetail(inst);
              }}
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
              </div>
              <div class="av-service-meta">
                <Show when={(props.dependsOn.get(inst.id) ?? []).length > 0}>
                  <span>
                    {t("apps.dependsOn", {
                      names: (props.dependsOn.get(inst.id) ?? []).join(", "),
                    })}
                  </span>
                </Show>
                <Show
                  when={
                    effectiveInstallationStatus(inst) === "stale" &&
                    props.staleReasons.get(inst.id)
                  }
                >
                  {(reason) => (
                    <span class="av-service-warn">
                      {t("apps.staleReason", { reason: reason() })}
                    </span>
                  )}
                </Show>
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
                      variant="ghost"
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
                  <>
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
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => props.openDetail(inst)}
                    >
                      {t("apps.viewDetails")}
                    </Button>
                  </>
                )}
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

function ServiceLauncherHeader(props: {
  readonly serviceCount: number;
  readonly deployedCount: number;
  readonly attentionCount: number;
}) {
  return (
    <section class="av-summary" aria-label={t("apps.summary.aria")}>
      <div class="av-summary-copy">
        <h2>{t("apps.summary.title")}</h2>
        <p>
          {t("apps.summary.body", {
            total: props.serviceCount,
            deployed: props.deployedCount,
          })}
        </p>
      </div>
      <div class="av-summary-actions">
        <Show
          when={props.attentionCount > 0}
          fallback={<Badge tone="ok">{t("apps.summary.clear")}</Badge>}
        >
          <Badge tone="warn">
            {t("apps.summary.needsAttention", { n: props.attentionCount })}
          </Badge>
        </Show>
      </div>
    </section>
  );
}

function WorkspaceStartPanel() {
  return (
    <section class="av-start" aria-label={t("apps.start.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("apps.start.kicker")}</span>
        <h2 class="av-start-title">{t("apps.start.titleEmpty")}</h2>
        <p class="av-start-sub">{t("apps.start.bodyEmpty")}</p>
        <div class="av-start-actions">
          <Button variant="primary" href="/new" icon={<Plus size={16} />}>
            {t("apps.start.add")}
          </Button>
        </div>
      </div>
    </section>
  );
}
