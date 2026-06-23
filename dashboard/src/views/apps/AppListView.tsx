/**
 * Home (`/`) — the Workspace app launcher, the dashboard's primary surface.
 *
 * Each service is one tappable app tile (icon + name). Tapping opens the live
 * app when its public outputs expose a launch URL, otherwise its service
 * screen. A trailing "add" tile starts a new service. Management surfaces
 * (history / connections / settings) live in the profile menu, so the home
 * stays a launcher — not an ops console.
 */
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Box, Database, Globe, LayoutGrid, Plus, Sparkles } from "lucide-solid";
import type { JSX } from "solid-js";
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
  listInstallConfigs,
} from "../../lib/control-api.ts";
import {
  isVisibleServiceInstallation,
  launchUrlFromOutputs,
  needsAttention,
} from "../../lib/installations-ui.ts";
import { t } from "../../i18n/index.ts";
import { Button, Toast } from "../../components/ui/index.ts";
import { createAction } from "../account/lib/action.tsx";

export default function AppListView() {
  return <Page title={t("apps.title")}>{() => <Inner />}</Page>;
}

/** A type-specific launcher icon so services read as distinct apps, not rows. */
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
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);

  const [installations] = createResource(spaceId, listInstallations);
  const visibleInstallations = createMemo(() =>
    (installations() ?? []).filter(isVisibleServiceInstallation),
  );

  // Map each Installation to a type-specific icon via its install config's
  // catalog kind (site / storage / worker), so the launcher shows distinct app
  // icons instead of one generic glyph for everything.
  const [installConfigs] = createResource(spaceId, (id) =>
    listInstallConfigs(id),
  );
  const kindByConfigId = createMemo(() => {
    const map = new Map<string, string>();
    for (const config of installConfigs() ?? []) {
      const kind = config.catalog?.kind;
      if (kind) map.set(config.id, kind);
    }
    return map;
  });
  const iconForInstallation = (inst: Installation): JSX.Element =>
    serviceKindIcon(kindByConfigId().get(inst.installConfigId));

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
            // One failing deployment read must not blank the launcher; that
            // tile simply opens its service screen instead of a live URL.
          }
        }),
    );
    return map;
  });

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

  const openDetail = (inst: Installation) =>
    navigate(`/services/${encodeURIComponent(inst.id)}`);

  return (
    <AppShell>
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
        <Switch>
          <Match when={installations.loading}>
            <ul class="av-launcher">
              <For each={Array.from({ length: 6 })}>
                {() => (
                  <li>
                    <span class="av-tile" aria-hidden="true">
                      <span class="tg-skel av-tile-skel" />
                    </span>
                  </li>
                )}
              </For>
            </ul>
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
                  iconFor={iconForInstallation}
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
  readonly iconFor: (inst: Installation) => JSX.Element;
}) {
  return (
    <ul class="av-launcher">
      <For each={props.installations}>
        {(inst) => (
          <li>
            <ServiceTile
              inst={inst}
              url={props.launchUrls.get(inst.id)}
              icon={props.iconFor(inst)}
              onOpenDetail={() => props.openDetail(inst)}
            />
          </li>
        )}
      </For>
      <li>
        <a class="av-tile av-tile-add" href="/new">
          <span class="av-tile-icon" aria-hidden="true">
            <Plus />
          </span>
          <span class="av-tile-name">{t("apps.add")}</span>
        </a>
      </li>
    </ul>
  );
}

/**
 * One launcher tile. A live launch URL renders an anchor that opens the app in
 * a new tab; otherwise a button that opens the service screen. Needs-attention
 * shows as a corner dot on the icon (plus a screen-reader label), keeping the
 * tile copy-free.
 */
function ServiceTile(props: {
  readonly inst: Installation;
  readonly url: string | undefined;
  readonly icon: JSX.Element;
  readonly onOpenDetail: () => void;
}) {
  const attention = () => needsAttention(props.inst);
  const body = () => (
    <>
      <span
        class="av-tile-icon"
        classList={{ "av-tile-icon-attention": attention() }}
        aria-hidden="true"
      >
        {props.icon}
        <Show when={attention()}>
          <span class="av-tile-dot" />
        </Show>
      </span>
      <span class="av-tile-name">{props.inst.name}</span>
      <Show when={attention()}>
        <span class="sr-only">{t("apps.needsAttention")}</span>
      </Show>
    </>
  );
  return (
    <Show
      when={props.url}
      fallback={
        <button type="button" class="av-tile" onClick={props.onOpenDetail}>
          {body()}
        </button>
      }
    >
      {(url) => (
        <a
          class="av-tile"
          href={url()}
          target="_blank"
          rel="noreferrer noopener"
        >
          {body()}
        </a>
      )}
    </Show>
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
