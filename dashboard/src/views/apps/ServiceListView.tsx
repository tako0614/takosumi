/**
 * Services (`/services`) — the full list of every Capsule in the Workspace
 * (apps and infra alike): the technical / OpenTofu surface. Each row opens the
 * service detail (deploys / state / outputs / settings). The consumer-facing
 * app launcher (declared apps only) lives on the separate `/` Apps page.
 */
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Box,
  ChevronRight,
  Database,
  Globe,
  LayoutGrid,
  Plus,
  Trash2,
} from "lucide-solid";
import type { JSX } from "solid-js";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { getDashboardOverviewCached } from "../../lib/dashboard-overview.ts";
import { type ControlApiError, type Capsule } from "../../lib/control-api.ts";
import {
  effectiveCapsuleStatus,
  isVisibleServiceCapsule,
} from "../../lib/capsules-ui.ts";
import { capsuleStatusLabel, capsuleTone } from "../../lib/labels.ts";
import { relativeTime, t } from "../../i18n/index.ts";
import {
  Button,
  Skeleton,
  StatusBadge,
  Toast,
} from "../../components/ui/index.ts";

export default function ServiceListView() {
  return <Page title={t("services.title")}>{() => <Inner />}</Page>;
}

function serviceKindIcon(kind: string | undefined): JSX.Element {
  switch (kind) {
    case "site":
      return <Globe />;
    case "storage":
      return <Database />;
    case "worker":
      return <Box />;
    default:
      return <LayoutGrid />;
  }
}

function Inner() {
  const navigate = useNavigate();
  const workspaceId = () => currentWorkspaceId() || undefined;

  const [overview] = createResource(workspaceId, (id) =>
    getDashboardOverviewCached(id),
  );
  const capsules = createMemo(() => overview()?.capsules ?? []);
  const visible = createMemo(() =>
    (capsules() ?? []).filter(isVisibleServiceCapsule),
  );
  const installConfigs = createMemo(() => overview()?.installConfigs ?? []);
  const kindByConfigId = createMemo(() => {
    const map = new Map<string, string>();
    for (const config of installConfigs() ?? []) {
      const kind = config.catalog?.kind;
      if (kind) map.set(config.id, kind);
    }
    return map;
  });
  const open = (inst: Capsule) =>
    navigate(`/services/${encodeURIComponent(inst.id)}`);
  const deleteHref = (inst: Capsule) =>
    `/services/${encodeURIComponent(inst.id)}/danger`;

  return (
    <AppShell>
      {/* Title lives in the top bar; this slim toolbar carries the page's
          context line + the add action. */}
      <div class="av-list-toolbar">
        <span class="av-list-toolbar-sub">{t("services.subtitle")}</span>
        <Button variant="primary" href="/new" icon={<Plus size={16} />}>
          {t("apps.add")}
        </Button>
      </div>
      <Show
        when={workspaceId()}
        fallback={<Toast tone="neutral">{t("workspace.selectMessage")}</Toast>}
      >
        <Switch>
          <Match when={overview.loading}>
            <div class="av-service-rows">
              <Skeleton variant="row" count={5} />
            </div>
          </Match>
          <Match when={overview.error}>
            <Toast tone="error">
              {t("common.fetchFailed", {
                message: (overview.error as ControlApiError).message,
              })}
            </Toast>
          </Match>
          <Match when={overview()}>
            <Show when={visible().length > 0} fallback={<ServicesEmpty />}>
              <ul class="av-service-rows">
                <For each={visible()}>
                  {(inst) => (
                    <li>
                      <div class="av-service-row">
                        <button
                          type="button"
                          class="av-service-row-main"
                          onClick={() => open(inst)}
                        >
                          <span class="av-service-row-icon" aria-hidden="true">
                            {serviceKindIcon(
                              kindByConfigId().get(inst.installConfigId),
                            )}
                          </span>
                          <span class="av-service-row-name">{inst.name}</span>
                          <StatusBadge
                            status={effectiveCapsuleStatus(inst)}
                            label={capsuleStatusLabel}
                            tone={capsuleTone}
                          />
                          <span class="av-service-row-time">
                            {relativeTime(inst.updatedAt)}
                          </span>
                          <ChevronRight
                            class="av-service-row-chevron"
                            size={18}
                            aria-hidden="true"
                          />
                        </button>
                        <a
                          class="av-service-row-delete"
                          href={deleteHref(inst)}
                          title={t("app.danger.destroyTitle")}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                          <span>{t("common.delete")}</span>
                        </a>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}

function ServicesEmpty() {
  return (
    <section class="av-start" aria-label={t("services.empty.title")}>
      <div class="av-start-copy">
        <h2 class="av-start-title">{t("services.empty.title")}</h2>
        <p class="av-start-sub">{t("services.empty.body")}</p>
      </div>
      <a href="/new" class="av-start-action">
        <Plus size={18} aria-hidden="true" />
        <span>{t("apps.add")}</span>
      </a>
    </section>
  );
}
