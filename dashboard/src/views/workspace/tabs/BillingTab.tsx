/**
 * Provider-neutral Workspace usage/showback surface. Optional commercial
 * account management is supplied by a platform extension contribution and is
 * never compiled into the OSS dashboard.
 */
import "../../../styles/wave-b.css";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { ExternalLink } from "lucide-solid";
import {
  formatBillingNumber,
  formatUsdMicros,
  usageUsdMicros,
} from "../../../lib/billing-format.ts";
import {
  getWorkspaceBilling,
  listWorkspaceUsagePage,
  type UsageEvent,
} from "../../../lib/control-api.ts";
import {
  loadPlatformContributions,
  platformContributionDescription,
  platformContributionLabel,
  platformContributionsForSlot,
} from "../../../lib/platform-contributions.ts";
import {
  formatDateTime,
  intlLocale,
  type MessageKey,
  t,
} from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  type Column,
  DataTable,
  KVList,
  Toast,
} from "../../../components/ui/index.ts";

const MODE_KEY: Record<string, MessageKey> = {
  disabled: "billing.mode.disabled",
  showback: "billing.mode.showback",
};
const USAGE_LEDGER_PAGE_SIZE = 25;

export default function BillingTab(props: { readonly workspaceId: string }) {
  const [billing, { refetch }] = createResource(
    () => props.workspaceId,
    getWorkspaceBilling,
  );
  const [contributions] = createResource(loadPlatformContributions);
  const [usageRows, setUsageRows] = createSignal<readonly UsageEvent[]>([]);
  const [usageCursor, setUsageCursor] = createSignal<string | undefined>();
  const [usageLoaded, setUsageLoaded] = createSignal(false);
  const [usageLoading, setUsageLoading] = createSignal(false);
  const [usageError, setUsageError] = createSignal<string | undefined>();

  const current = createMemo(() => (billing.error ? undefined : billing()));
  const mode = createMemo(() => current()?.settings.mode ?? "disabled");

  const usageColumns = createMemo<readonly Column<UsageEvent>[]>(() => [
    {
      header: t("billing.usage.time"),
      cell: (event) => formatDateTime(event.createdAt),
    },
    {
      header: t("billing.usage.kind"),
      cell: (event) => usageKindLabel(event.kind),
    },
    {
      header: t("billing.usage.quantity"),
      align: "right",
      cell: (event) => formatBillingNumber(event.quantity),
    },
    {
      header: t("billing.usage.amount"),
      align: "right",
      cell: (event) =>
        event.ratingStatus === "rated"
          ? formatUsdMicros(usageUsdMicros(event))
          : t("billing.usage.unrated"),
    },
  ]);

  const loadUsage = async (append: boolean) => {
    if (usageLoading()) return;
    setUsageLoading(true);
    setUsageError(undefined);
    try {
      const page = await listWorkspaceUsagePage(props.workspaceId, {
        limit: USAGE_LEDGER_PAGE_SIZE,
        ...(append && usageCursor() ? { cursor: usageCursor() } : {}),
      });
      setUsageRows((rows) =>
        append ? [...rows, ...page.usageEvents] : page.usageEvents,
      );
      setUsageCursor(page.nextCursor);
      setUsageLoaded(true);
    } catch (error) {
      setUsageError(errorMessage(error));
    } finally {
      setUsageLoading(false);
    }
  };

  return (
    <div class="wa-stack">
      <Show when={billing.error}>
        <Toast tone="error">
          {t("billing.loadError", { message: errorMessage(billing.error) })}
          <Button size="sm" variant="secondary" onClick={() => void refetch()}>
            {t("common.retry")}
          </Button>
        </Toast>
      </Show>

      <Show when={current()}>
        <Card>
          <CardHeader
            title={t("billing.usageQuotaTitle")}
            subtitle={t("billing.usageQuotaSubtitle")}
          />
          <KVList
            items={[
              {
                label: t("billing.mode.label"),
                value: t(MODE_KEY[mode()] ?? "billing.mode.disabled"),
              },
            ]}
          />
        </Card>
      </Show>

      <For
        each={platformContributionsForSlot(
          contributions(),
          "workspace.billing",
        )}
      >
        {(contribution) => (
          <Card>
            <CardHeader
              title={platformContributionLabel(contribution, intlLocale())}
              subtitle={platformContributionDescription(
                contribution,
                intlLocale(),
              )}
            />
            <a
              class="btn btn-secondary"
              href={`${contribution.href}?workspaceId=${encodeURIComponent(props.workspaceId)}`}
            >
              {platformContributionLabel(contribution, intlLocale())}
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          </Card>
        )}
      </For>

      <Card>
        <CardHeader
          title={t("billing.usage.title")}
          subtitle={t("billing.usage.subtitle")}
        />
        <Show
          when={usageLoaded()}
          fallback={
            <Button
              variant="secondary"
              busy={usageLoading()}
              onClick={() => void loadUsage(false)}
            >
              {t("billing.usage.load")}
            </Button>
          }
        >
          <Show when={usageError()}>
            <Toast tone="error">{usageError()}</Toast>
          </Show>
          <DataTable
            columns={usageColumns()}
            rows={usageRows()}
            rowKey={(event) => event.id}
            empty={t("billing.usage.empty")}
          />
          <Show when={usageCursor()}>
            <Button
              variant="secondary"
              busy={usageLoading()}
              onClick={() => void loadUsage(true)}
            >
              {t("billing.usage.more")}
            </Button>
          </Show>
        </Show>
      </Card>
    </div>
  );
}

function usageKindLabel(kind: string): string {
  const key = `billing.usage.kind.${kind}` as MessageKey;
  const translated = t(key);
  return translated === key ? kind : translated;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
