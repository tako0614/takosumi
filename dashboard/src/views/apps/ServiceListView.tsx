/**
 * Services (`/services`) — the full list of every Capsule in the Workspace
 * (apps and infra alike): the technical / OpenTofu surface. Each row opens the
 * service detail (deploys / state / outputs / settings). The consumer-facing
 * app launcher lives on the separate `/` Apps page.
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
import Page from "../account/components/auth/Page.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { getDashboardOverviewCached } from "../../lib/dashboard-overview.ts";
import { listCapsulesCached } from "../../lib/capsule-list.ts";
import { type Capsule } from "../../lib/control-api.ts";
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
import { fetchFailedMessage } from "../../lib/error-copy.ts";

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

  const [overview, { refetch: refetchOverview }] = createResource(
    workspaceId,
    (id) => getDashboardOverviewCached(id),
  );
  // The overview projection caps the capsule list (nextCapsuleCursor); the
  // full service list must show every service, so fetch the rest when capped.
  const fullListWorkspaceId = createMemo(() =>
    overview()?.nextCapsuleCursor ? workspaceId() : undefined,
  );
  const [fullCapsules, { refetch: refetchFullCapsules }] = createResource(
    fullListWorkspaceId,
    (id) => listCapsulesCached(id, { includeDestroyed: false }),
  );
  const capsules = createMemo(() => {
    const base = overview()?.capsules ?? [];
    // `.error` first: reading an errored resource THROWS. A failed
    // supplemental full-list fetch degrades to the overview's first page (the
    // fullCapsules.error toast + retry handles surfacing it) instead of
    // white-screening the list.
    const extra = fullCapsules.error ? [] : (fullCapsules() ?? []);
    if (extra.length === 0) return base;
    const byId = new Map<string, Capsule>();
    for (const c of [...base, ...extra]) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()];
  });
  const visible = createMemo(() =>
    (capsules() ?? []).filter(isVisibleServiceCapsule),
  );
  const installConfigs = createMemo(() => overview()?.installConfigs ?? []);
  const kindByConfigId = createMemo(() => {
    const map = new Map<string, string>();
    for (const config of installConfigs() ?? []) {
      const kind = config.store?.kind;
      if (kind) map.set(config.id, kind);
    }
    return map;
  });
  const open = (inst: Capsule) =>
    navigate(`/services/${encodeURIComponent(inst.id)}`);
  const deleteHref = (inst: Capsule) =>
    `/services/${encodeURIComponent(inst.id)}/danger`;

  return (
    <>
      {/* Title lives in the top bar (outside the page outline), so give the
          document outline a heading root without repeating it visually. */}
      <h1 class="sr-only">{t("services.title")}</h1>
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
              {fetchFailedMessage(overview.error, t)}
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void refetchOverview()}
              >
                {t("common.retry")}
              </Button>
            </Toast>
          </Match>
          <Match when={overview()}>
            {/* The supplemental full-list fetch failing must not silently
                truncate the list to the overview's first page. */}
            <Show when={fullCapsules.error}>
              <Toast tone="error">
                {t("services.listIncomplete")}
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => void refetchFullCapsules()}
                >
                  {t("common.retry")}
                </Button>
              </Toast>
            </Show>
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
                          // Every row repeats the same visible "削除"; the
                          // accessible name says which service it deletes.
                          aria-label={t("services.deleteAria", {
                            name: inst.name,
                          })}
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
    </>
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
