/**
 * Provider-neutral Workspace usage/showback surface. Optional commercial
 * account management is activated by a platform extension contribution. The
 * dashboard owns its native presentation while the extension remains the sole
 * owner of prices, payment processing, tax policy, and billing records.
 */
import "../../../styles/wave-b.css";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
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
  type PlatformContribution,
} from "../../../lib/platform-contributions.ts";
import { hasPlatformExtensionCapability } from "../../../lib/runtime-capabilities.ts";
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
import { friendlyError } from "../../../lib/error-copy.ts";
import CommercialBillingPanel from "../../../components/billing/CommercialBillingPanel.tsx";

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
  const [usageLoading, setUsageLoading] = createSignal(false);
  const [usageLoaded, setUsageLoaded] = createSignal(false);
  const [usageDetailsOpen, setUsageDetailsOpen] = createSignal(false);
  const [usageError, setUsageError] = createSignal<string | undefined>();

  const current = createMemo(() => (billing.error ? undefined : billing()));
  const mode = createMemo(() => current()?.settings.mode ?? "disabled");
  const commercialBillingEnabled = createMemo(
    () =>
      hasPlatformExtensionCapability("billing.commercial.v1") &&
      platformContributionsForSlot(
        contributions(),
        "workspace.billing",
      ).some((contribution) => contribution.presentation === "native"),
  );

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
      setUsageError(friendlyError(error, t).message);
    } finally {
      setUsageLoading(false);
    }
  };

  const handleUsageToggle = (event: Event) => {
    const details = event.currentTarget as HTMLDetailsElement | null;
    if (!details?.open) return;
    setUsageDetailsOpen(true);
    if (!usageLoaded() && !usageLoading()) void loadUsage(false);
  };

  return (
    <div class="wa-stack">
      <Show when={billing.error}>
        <Toast tone="error">
          {t("billing.loadError", {
            message: friendlyError(billing.error, t).message,
          })}
          <Button size="sm" variant="secondary" onClick={() => void refetch()}>
            {t("common.retry")}
          </Button>
        </Toast>
      </Show>

      <Show when={current() && !commercialBillingEnabled()}>
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
        {(contribution) => {
          const label = () =>
            platformContributionLabel(contribution, intlLocale());
          const description = () =>
            platformContributionDescription(contribution, intlLocale());
          return (
            <Switch>
              <Match
                when={
                  contribution.presentation === "native" &&
                  hasPlatformExtensionCapability("billing.commercial.v1")
                }
              >
                <CommercialBillingPanel
                  basePath={contribution.href}
                  workspaceId={props.workspaceId}
                  title={label()}
                  description={description()}
                />
              </Match>
              <Match when={contribution.presentation === "inline-frame"}>
                <InlinePlatformContribution
                  contribution={contribution}
                  workspaceId={props.workspaceId}
                />
              </Match>
              <Match when>
                <Card>
                  <CardHeader title={label()} subtitle={description()} />
                  <a
                    class="btn btn-secondary"
                    href={platformContributionHref(
                      contribution,
                      props.workspaceId,
                    )}
                    rel="external"
                  >
                    {label()}
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </Card>
              </Match>
            </Switch>
          );
        }}
      </For>

      <Card class="wb-billing-history">
        <details
          class="wb-billing-disclosure"
          onToggle={handleUsageToggle}
        >
          <summary>
            <span>
              <span>
                <strong>{t("billing.usage.title")}</strong>
                <small>{t("billing.usage.subtitle")}</small>
              </span>
            </span>
            <span>{t("common.details")}</span>
          </summary>
          <Show when={usageDetailsOpen()}>
            <div class="wb-billing-history-body">
              <Show when={usageError()}>
                {(message) => (
                  <Toast tone="error">
                    {t("billing.usage.error", { message: message() })}
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      busy={usageLoading()}
                      onClick={() => void loadUsage(false)}
                    >
                      {t("common.retry")}
                    </Button>
                  </Toast>
                )}
              </Show>
              <Show when={!usageError()}>
                <DataTable
                  columns={usageColumns()}
                  rows={usageRows()}
                  rowKey={(event) => event.id}
                  loading={usageLoading() && usageRows().length === 0}
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
            </div>
          </Show>
        </details>
      </Card>
    </div>
  );
}

const CONTRIBUTION_RESIZE_KIND =
  "takosumi.platform-contribution-resize@v1" as const;

function InlinePlatformContribution(props: {
  readonly contribution: PlatformContribution;
  readonly workspaceId: string;
}) {
  let frame!: HTMLIFrameElement;
  const [height, setHeight] = createSignal(620);
  const label = () =>
    platformContributionLabel(props.contribution, intlLocale());
  const description = () =>
    platformContributionDescription(props.contribution, intlLocale());

  onMount(() => {
    const resize = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.contentWindow ||
        !isContributionResizeMessage(event.data) ||
        event.data.id !== props.contribution.id
      ) {
        return;
      }
      setHeight(Math.max(320, Math.min(1_600, Math.ceil(event.data.height))));
    };
    window.addEventListener("message", resize);
    onCleanup(() => window.removeEventListener("message", resize));
  });

  return (
    <section class="platform-contribution-inline" aria-label={label()}>
      <div class="platform-contribution-heading">
        <h2>{label()}</h2>
        <Show when={description()}>{(text) => <p>{text()}</p>}</Show>
      </div>
      <iframe
        ref={frame}
        class="platform-contribution-frame"
        src={platformContributionHref(
          props.contribution,
          props.workspaceId,
          true,
        )}
        title={label()}
        style={{ height: `${height()}px` }}
      />
    </section>
  );
}

function platformContributionHref(
  contribution: PlatformContribution,
  workspaceId: string,
  embedded = false,
): string {
  const query = new URLSearchParams({ workspaceId });
  if (embedded) query.set("embed", "1");
  return `${contribution.href}?${query.toString()}`;
}

function isContributionResizeMessage(value: unknown): value is {
  readonly kind: typeof CONTRIBUTION_RESIZE_KIND;
  readonly id: string;
  readonly height: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === CONTRIBUTION_RESIZE_KIND &&
    typeof record.id === "string" &&
    typeof record.height === "number" &&
    Number.isFinite(record.height)
  );
}

/**
 * Usage kinds arrive as snake_case backend tokens (`runner_minute`). The label
 * keys now match those tokens exactly; an unrecognized kind falls back to the
 * neutral "unknown" word rather than leaking the raw enum, matching the
 * contract stated in lib/labels.ts.
 */
function usageKindLabel(kind: string): string {
  const key = `billing.usage.kind.${kind}` as MessageKey;
  const translated = t(key);
  return translated === key ? t("common.unknown") : translated;
}
