/**
 * Home (`/`) — the per-Space app list, the dashboard's primary surface.
 *
 * Card grid over the control-plane Installation list: status, a direct "開く"
 * launch link resolved from the current Deployment's public outputs, the
 * dependency line from the Space graph, and a needs-attention strip derived
 * from app statuses (error / stale). Click-through goes to `/apps/:id`.
 */
import {
  createMemo,
  createResource,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Boxes, Network, Plus } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId } from "../control/space-state.ts";
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
        .filter((inst): inst is Installation & { currentDeploymentId: string } =>
          Boolean(inst.currentDeploymentId)
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

  /** Apps currently needing attention (error / stale under either model). */
  const attentionCount = createMemo(
    () => (installations() ?? []).filter(needsAttention).length,
  );

  const openDetail = (inst: Installation) =>
    navigate(`/apps/${encodeURIComponent(inst.id)}`);

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
            <Button
              variant="ghost"
              href="/graph"
              icon={<Network size={16} />}
            >
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
              <Show
                when={list().length > 0}
                fallback={
                  <EmptyState
                    ink
                    icon={<Boxes size={28} />}
                    title={t("apps.empty.title")}
                    message={t("apps.empty.message")}
                    action={
                      <Button
                        variant="primary"
                        href="/new"
                        icon={<Plus size={16} />}
                      >
                        {t("apps.empty.cta")}
                      </Button>
                    }
                  />
                }
              >
                <ul class="av-grid">
                  <For each={list()}>
                    {(inst) => (
                      <li>
                        <button
                          type="button"
                          class="av-card"
                          onClick={() => openDetail(inst)}
                        >
                          <div class="av-card-head">
                            <span class="av-card-name">{inst.name}</span>
                            <StatusBadge
                              status={effectiveInstallationStatus(inst)}
                              label={installationStatusLabel}
                              tone={installationTone}
                            />
                          </div>
                          <Show
                            when={(dependsOn().get(inst.id) ?? []).length > 0}
                          >
                            <p class="av-card-meta">
                              {t("apps.dependsOn", {
                                names: (dependsOn().get(inst.id) ?? []).join(
                                  ", ",
                                ),
                              })}
                            </p>
                          </Show>
                          <Show
                            when={
                              effectiveInstallationStatus(inst) === "stale" &&
                              staleReasons().get(inst.id)
                            }
                          >
                            {(reason) => (
                              <p class="av-card-meta av-card-warn">
                                {t("apps.staleReason", { reason: reason() })}
                              </p>
                            )}
                          </Show>
                          <Show when={inst.currentOutputSnapshotId}>
                            <p class="av-card-meta">
                              <Badge tone="info">outputs</Badge>
                            </p>
                          </Show>
                        </button>
                        <Show when={launchUrls()?.get(inst.id)}>
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
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}
