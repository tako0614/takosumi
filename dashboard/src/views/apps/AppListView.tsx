/**
 * Home (`/`) — the per-Workspace Capsule list, the dashboard's primary surface.
 *
 * Card grid over the current compatibility Installation list: status, a direct
 * "開く" launch link resolved from public outputs, the dependency line from the
 * Workspace graph, and a needs-attention strip derived from Capsule lifecycle
 * status (error / stale). Click-through goes to
 * `/capsules/:id`.
 */
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Boxes,
  Cloud,
  GitBranch,
  Network,
  PlayCircle,
  Plus,
} from "lucide-solid";
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

  /** Capsules currently needing attention (error / stale under either model). */
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
            <Button variant="ghost" href="/graph" icon={<Network size={16} />}>
              {t("apps.graphLink")}
            </Button>
          </div>
        }
      />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
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
            <div class="av-grid">
              <Skeleton variant="card" count={3} />
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
                      <WorkspaceSummaryBar
                        serviceCount={list().length}
                        deployedCount={deployedCount()}
                        attentionCount={attentionCount()}
                      />
                      <ServiceGrid
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

function ServiceGrid(props: {
  readonly installations: readonly Installation[];
  readonly dependsOn: ReadonlyMap<string, readonly string[]>;
  readonly staleReasons: ReadonlyMap<string, string>;
  readonly launchUrls: ReadonlyMap<string, string>;
  readonly openDetail: (inst: Installation) => void;
}) {
  return (
    <ul class="av-grid">
      <For each={props.installations}>
        {(inst) => (
          <li>
            <button
              type="button"
              class="av-card"
              onClick={() => props.openDetail(inst)}
            >
              <div class="av-card-head">
                <span class="av-card-name">{inst.name}</span>
                <StatusBadge
                  status={effectiveInstallationStatus(inst)}
                  label={installationStatusLabel}
                  tone={installationTone}
                />
              </div>
              <Show when={(props.dependsOn.get(inst.id) ?? []).length > 0}>
                <p class="av-card-meta">
                  {t("apps.dependsOn", {
                    names: (props.dependsOn.get(inst.id) ?? []).join(", "),
                  })}
                </p>
              </Show>
              <Show
                when={
                  effectiveInstallationStatus(inst) === "stale" &&
                  props.staleReasons.get(inst.id)
                }
              >
                {(reason) => (
                  <p class="av-card-meta av-card-warn">
                    {t("apps.staleReason", { reason: reason() })}
                  </p>
                )}
              </Show>
              <Show when={inst.currentDeploymentId}>
                <p class="av-card-meta">
                  <Badge tone="info">outputs</Badge>
                </p>
              </Show>
            </button>
            <Show when={props.launchUrls.get(inst.id)}>
              {(url) => (
                <div class="av-card-foot">
                  <Button
                    variant="primary"
                    size="sm"
                    href={url()}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t("apps.openApp")} ↗
                  </Button>
                </div>
              )}
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

function WorkspaceSummaryBar(props: {
  readonly serviceCount: number;
  readonly deployedCount: number;
  readonly attentionCount: number;
}) {
  return (
    <section class="av-summary" aria-label={t("apps.summary.aria")}>
      <div class="av-summary-metrics">
        <span class="av-summary-metric">
          <span class="av-summary-label">{t("apps.summary.total")}</span>
          <strong>{props.serviceCount}</strong>
        </span>
        <span class="av-summary-metric">
          <span class="av-summary-label">{t("apps.summary.deployed")}</span>
          <strong>{props.deployedCount}</strong>
        </span>
      </div>
      <Show
        when={props.attentionCount > 0}
        fallback={<Badge tone="ok">{t("apps.summary.clear")}</Badge>}
      >
        <Badge tone="warn">
          {t("apps.summary.needsAttention", { n: props.attentionCount })}
        </Badge>
      </Show>
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
          <Button
            variant="secondary"
            href="/workspace/settings/connections"
            icon={<Cloud size={16} />}
          >
            {t("apps.start.connections")}
          </Button>
        </div>
      </div>
      <ol class="av-start-steps">
        <li>
          <span class="av-start-step-icon">
            <GitBranch size={16} />
          </span>
          <span>
            <strong>{t("apps.start.stepSource")}</strong>
            <small>{t("apps.start.stepSourceSub")}</small>
          </span>
        </li>
        <li>
          <span class="av-start-step-icon">
            <Cloud size={16} />
          </span>
          <span>
            <strong>{t("apps.start.stepConnection")}</strong>
            <small>{t("apps.start.stepConnectionSub")}</small>
          </span>
        </li>
        <li>
          <span class="av-start-step-icon">
            <PlayCircle size={16} />
          </span>
          <span>
            <strong>{t("apps.start.stepDeploy")}</strong>
            <small>{t("apps.start.stepDeploySub")}</small>
          </span>
        </li>
      </ol>
    </section>
  );
}
