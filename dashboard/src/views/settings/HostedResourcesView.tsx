import { A } from "@solidjs/router";
import { CloudCog } from "lucide-solid";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";
import Page from "../account/components/auth/Page.tsx";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  PageHeader,
  Toast,
  type Column,
  type Tone,
} from "../../components/ui/index.ts";
import {
  HOSTED_RESOURCE_INVENTORY_PAGE_SIZE,
  hostedResourceInventoryQuery,
  loadHostedResourceContribution,
  listHostedResourceInventoryPage,
  type HostedResourceCondition,
  type HostedResourceInventoryItem,
} from "../../lib/hosted-resources.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { type MessageKey, t } from "../../i18n/index.ts";

interface HostedResourceStatus {
  readonly label: MessageKey;
  readonly tone: Tone;
}

export default function HostedResourcesView(): JSX.Element {
  return <Page title={t("hostedResources.title")}>{() => <Inner />}</Page>;
}

function Inner(): JSX.Element {
  const [contribution, { refetch: refetchContribution }] = createResource(
    () => loadHostedResourceContribution(),
  );
  const query = createMemo(() =>
    hostedResourceInventoryQuery(
      contribution.error ? undefined : contribution.latest,
      currentWorkspaceId() || undefined,
    ),
  );
  const [inventory, { refetch: refetchInventory }] = createResource(
    query,
    ({ href, workspaceId }) =>
      listHostedResourceInventoryPage(href, workspaceId),
  );
  const [items, setItems] = createSignal<
    readonly HostedResourceInventoryItem[]
  >([]);
  const [nextCursor, setNextCursor] = createSignal<string>();
  const [loadMoreBusy, setLoadMoreBusy] = createSignal(false);
  const [loadMoreError, setLoadMoreError] = createSignal(false);
  let activeQueryKey = "";

  // Keep a visible page while a same-scope refresh runs, but clear it when the
  // Workspace or host contribution changes so data cannot cross boundaries.
  createEffect(() => {
    const current = query();
    const key = current ? `${current.workspaceId}\u0000${current.href}` : "";
    if (key !== activeQueryKey) {
      activeQueryKey = key;
      setItems([]);
      setNextCursor(undefined);
      setLoadMoreError(false);
    }
    if (!current || inventory.error) return;
    const latest = inventory.latest;
    if (!latest || latest.workspaceId !== current.workspaceId) return;
    setItems(latest.items);
    setNextCursor(latest.nextCursor);
  });

  const columns = createMemo<readonly Column<HostedResourceInventoryItem>[]>(
    () => [
      {
        header: t("hostedResources.column.kind"),
        cell: (item) => <span class="hosted-resources-kind">{item.kind}</span>,
      },
      {
        header: t("hostedResources.column.name"),
        cell: (item) => <strong>{item.name}</strong>,
      },
      {
        header: t("hostedResources.column.status"),
        cell: (item) => {
          const status = hostedResourceStatus(item.conditions);
          return <Badge tone={status.tone}>{t(status.label)}</Badge>;
        },
      },
      {
        header: t("hostedResources.column.generation"),
        align: "right",
        cell: (item) => item.generation,
      },
      {
        header: t("hostedResources.column.workload"),
        cell: (item) => workloadLink(item),
      },
    ],
  );

  const initialLoading = () =>
    contribution.loading || (query() !== undefined && inventory.loading);
  const unavailable = () =>
    !contribution.loading &&
    (currentWorkspaceId() === undefined ||
      contribution.error !== undefined ||
      contribution.latest === undefined);
  const requestFailed = () =>
    !contribution.loading && query() !== undefined && inventory.error;

  const retry = () => {
    setLoadMoreError(false);
    if (contribution.error || contribution.latest === undefined) {
      void refetchContribution();
      return;
    }
    if (query() !== undefined) void refetchInventory();
  };

  const loadMore = async () => {
    const current = query();
    const cursor = nextCursor();
    if (!current || !cursor || loadMoreBusy()) return;
    setLoadMoreBusy(true);
    setLoadMoreError(false);
    try {
      const page = await listHostedResourceInventoryPage(
        current.href,
        current.workspaceId,
        cursor,
      );
      const after = query();
      if (
        !after ||
        after.href !== current.href ||
        after.workspaceId !== current.workspaceId
      ) {
        return;
      }
      setItems((previous) => [...previous, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      setLoadMoreError(true);
    } finally {
      setLoadMoreBusy(false);
    }
  };

  return (
    <div class="hosted-resources-view">
      <PageHeader
        eyebrow={t("settings.manage.title")}
        title={t("hostedResources.title")}
        subtitle={t("hostedResources.subtitle")}
      />

      <Show when={contribution.loading}>
        <Card>
          <div class="hosted-resources-loading" role="status">
            {t("hostedResources.loading")}
          </div>
        </Card>
      </Show>

      <Show when={currentWorkspaceId() === undefined && !contribution.loading}>
        <Card>
          <EmptyState
            icon={<CloudCog size={24} />}
            title={t("hostedResources.workspaceRequired")}
            message={t("hostedResources.workspaceRequiredMessage")}
          />
        </Card>
      </Show>

      <Show when={unavailable() && currentWorkspaceId() !== undefined}>
        <Card>
          <EmptyState
            icon={<CloudCog size={24} />}
            title={t("hostedResources.unavailableTitle")}
            message={t("hostedResources.unavailableMessage")}
            action={
              <Button
                variant="secondary"
                type="button"
                busy={contribution.loading}
                onClick={retry}
              >
                {t("common.retry")}
              </Button>
            }
          />
        </Card>
      </Show>

      <Show when={!unavailable() && query() !== undefined}>
        <Show when={requestFailed() && items().length === 0}>
          <Toast tone="error">
            {t("hostedResources.loadError")}
            <Button variant="secondary" size="sm" type="button" onClick={retry}>
              {t("common.retry")}
            </Button>
          </Toast>
        </Show>
        <Show when={requestFailed() && items().length > 0}>
          <Toast tone="error">
            {t("hostedResources.loadError")}
            <Button variant="secondary" size="sm" type="button" onClick={retry}>
              {t("common.retry")}
            </Button>
          </Toast>
        </Show>

        <Show when={initialLoading() && items().length === 0}>
          <Card>
            <CardHeader title={t("hostedResources.loading")} />
            <div class="hosted-resources-loading" role="status">
              {t("common.loading")}
            </div>
          </Card>
        </Show>

        <Show when={!requestFailed() && !initialLoading() && items().length === 0}>
          <Card>
            <EmptyState
              icon={<CloudCog size={24} />}
              title={t("hostedResources.emptyTitle")}
              message={t("hostedResources.emptyMessage")}
            />
          </Card>
        </Show>

        <Show when={items().length > 0}>
          <Card class="hosted-resources-card">
            <div class="hosted-resources-table">
              <DataTable
                columns={columns()}
                rows={items()}
                rowKey={(item) => item.uid}
                loading={initialLoading() && items().length === 0}
                skeletonRows={HOSTED_RESOURCE_INVENTORY_PAGE_SIZE}
              />
            </div>
            <div class="hosted-resources-cards" aria-label={t("hostedResources.title")}>
              <For each={items()}>
                {(item) => <HostedResourceCard item={item} />}
              </For>
            </div>
          </Card>
        </Show>

        <Show when={loadMoreError()}>
          <Toast tone="error">
            {t("hostedResources.loadError")}
            <Button
              variant="secondary"
              size="sm"
              type="button"
              busy={loadMoreBusy()}
              onClick={() => void loadMore()}
            >
              {t("common.retry")}
            </Button>
          </Toast>
        </Show>
        <Show when={nextCursor() !== undefined}>
          <div class="hosted-resources-pagination">
            <Button
              variant="secondary"
              type="button"
              busy={loadMoreBusy()}
              onClick={() => void loadMore()}
            >
              {t("hostedResources.loadMore")}
            </Button>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function HostedResourceCard(props: {
  readonly item: HostedResourceInventoryItem;
}): JSX.Element {
  const status = () => hostedResourceStatus(props.item.conditions);
  return (
    <article class="hosted-resource-card">
      <div class="hosted-resource-card-heading">
        <div>
          <span class="hosted-resources-kind">{props.item.kind}</span>
          <h2>{props.item.name}</h2>
        </div>
        <Badge tone={status().tone}>{t(status().label)}</Badge>
      </div>
      <dl class="hosted-resource-card-details">
        <div>
          <dt>{t("hostedResources.column.generation")}</dt>
          <dd>{props.item.generation}</dd>
        </div>
        <div>
          <dt>{t("hostedResources.column.workload")}</dt>
          <dd>{workloadLink(props.item)}</dd>
        </div>
      </dl>
    </article>
  );
}

function workloadLink(item: HostedResourceInventoryItem): JSX.Element {
  if (!item.workloadId) {
    return <span aria-label={t("hostedResources.noWorkload")}>—</span>;
  }
  return (
    <A
      class="hosted-resources-workload"
      href={`/workloads/${encodeURIComponent(item.workloadId)}`}
      aria-label={`${t("hostedResources.openWorkload")}: ${item.workloadId}`}
    >
      {item.workloadId}
    </A>
  );
}

function hostedResourceStatus(
  conditions: readonly HostedResourceCondition[],
): HostedResourceStatus {
  const ready = conditions.find((condition) => condition.type === "Ready");
  if (!ready) {
    return { label: "hostedResources.status.unknown", tone: "muted" };
  }
  if (ready.status === "True") {
    return { label: "hostedResources.status.ready", tone: "ok" };
  }
  if (ready.status === "False") {
    return {
      label: "hostedResources.status.needsAttention",
      tone: "danger",
    };
  }
  return { label: "hostedResources.status.pending", tone: "warn" };
}
