/**
 * アカウント > 料金と利用量: what this workspace costs and what it used, in plain
 * words. Takosumi itself either charges nothing for the workspace or records use
 * without billing it; the clouds an app's resources run on bill separately.
 * An amount Takosumi has not priced is shown as unknown, never as zero.
 *
 * Optional commercial account management is activated by a platform extension
 * contribution. The dashboard owns its native presentation while the extension
 * remains the sole owner of prices, payment processing, tax policy, and
 * billing records.
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
  ControlApiError,
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
import { createServiceNames } from "../../../lib/service-names.ts";
import { intlLocale, type MessageKey, t } from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  Skeleton,
  Toast,
} from "../../../components/ui/index.ts";
import { friendlyError } from "../../../lib/error-copy.ts";
import CommercialBillingPanel from "../../../components/billing/CommercialBillingPanel.tsx";
import RelativeTime from "../../account/components/RelativeTime.tsx";

/** What Takosumi does with this workspace's use, by billing mode. */
const MODE_KEY: Record<string, MessageKey> = {
  disabled: "billing.mode.disabled",
  showback: "billing.mode.showback",
};
const USAGE_PAGE_SIZE = 25;

export default function BillingTab(props: { readonly workspaceId: string }) {
  const [billing, { refetch }] = createResource(
    () => props.workspaceId,
    getWorkspaceBilling,
  );
  const [contributions] = createResource(loadPlatformContributions);
  const appNames = createServiceNames(() => props.workspaceId);
  const [usageRows, setUsageRows] = createSignal<readonly UsageEvent[]>([]);
  const [usageCursor, setUsageCursor] = createSignal<string | undefined>();
  const [usageLoading, setUsageLoading] = createSignal(false);
  const [usageLoaded, setUsageLoaded] = createSignal(false);
  const [usageError, setUsageError] = createSignal<string | undefined>();

  const current = createMemo(() => (billing.error ? undefined : billing()));
  const mode = createMemo(() => current()?.settings.mode ?? "disabled");
  /** Billing is readable by the workspace's owners and admins only. */
  const forbidden = () =>
    billing.error instanceof ControlApiError && billing.error.status === 403;
  const commercialBillingEnabled = createMemo(
    () =>
      hasPlatformExtensionCapability("billing.commercial.v1") &&
      platformContributionsForSlot(
        contributions(),
        "workspace.billing",
      ).some((contribution) => contribution.presentation === "native"),
  );

  const loadUsage = async (append: boolean) => {
    if (usageLoading()) return;
    setUsageLoading(true);
    setUsageError(undefined);
    try {
      const page = await listWorkspaceUsagePage(props.workspaceId, {
        limit: USAGE_PAGE_SIZE,
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
  // This section exists to show use, so it reads it on open.
  onMount(() => void loadUsage(false));

  const amount = (event: UsageEvent) =>
    event.ratingStatus === "rated"
      ? formatUsdMicros(usageUsdMicros(event))
      : t("billing.usage.amountUnknown");

  return (
    <div class="acct-stack">
      <Switch>
        <Match when={forbidden()}>
          <Card>
            <CardHeader
              title={t("billing.title")}
              subtitle={t("billing.ownersOnly")}
            />
          </Card>
        </Match>
        <Match when={billing.error}>
          <Toast tone="error">
            {t("billing.loadError", {
              message: friendlyError(billing.error, t).message,
            })}
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              {t("common.retry")}
            </Button>
          </Toast>
        </Match>
        <Match when={current() && !commercialBillingEnabled()}>
          <Card>
            <CardHeader title={t("billing.title")} />
            <CardSection>
              <p>{t(MODE_KEY[mode()] ?? "billing.mode.disabled")}</p>
              <p class="muted">{t("billing.cloudCosts")}</p>
            </CardSection>
          </Card>
        </Match>
      </Switch>

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

      <Show when={!forbidden()}>
        <section class="acct-list-section" aria-label={t("billing.usage.title")}>
          <h2 class="acct-list-title">{t("billing.usage.title")}</h2>
          <p class="muted">{t("billing.usage.subtitle")}</p>
          <Switch>
            <Match when={usageError()}>
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
            </Match>
            <Match when={!usageLoaded()}>
              <Skeleton variant="card" count={2} />
            </Match>
            <Match when={usageRows().length === 0}>
              <p class="muted">{t("billing.usage.empty")}</p>
            </Match>
            <Match when>
              <ul class="acct-list">
                <For each={usageRows()}>
                  {(event) => (
                    <li class="acct-row tg-card">
                      <div class="acct-row-main">
                        <div class="acct-row-title">
                          <strong>{usageKindLabel(event.kind)}</strong>
                          <Show when={event.capsuleId}>
                            {(capsuleId) => (
                              <span class="muted">
                                {appNames().get(capsuleId()) ??
                                  t("billing.usage.removedApp")}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="acct-row-meta">
                          <RelativeTime iso={event.createdAt} />
                          <span>
                            {t("billing.usage.quantityLine", {
                              quantity: formatBillingNumber(event.quantity),
                            })}
                          </span>
                        </div>
                      </div>
                      <div class="acct-row-amount">{amount(event)}</div>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={usageCursor()}>
                <Button
                  variant="secondary"
                  busy={usageLoading()}
                  onClick={() => void loadUsage(true)}
                >
                  {t("billing.usage.more")}
                </Button>
              </Show>
            </Match>
          </Switch>
        </section>
      </Show>
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
