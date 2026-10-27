/**
 * What it created: the resources this app's last applied change recorded in
 * the person's cloud, grouped by cloud with readable names and counts, the
 * connection each cloud is reached through, what the operator hosts for it,
 * and what it has cost so far. An unknown cost is said to be unknown.
 */
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import { Badge, Skeleton } from "../../components/ui/index.ts";
import type {
  CapsuleCurrentResourceInventory,
  CapsuleUsageSummary,
  ProviderBinding,
  ProviderConnection,
} from "../../lib/control-api.ts";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import { formatUsdMicros } from "../../lib/billing-format.ts";
import {
  appCostState,
  groupInventoryResources,
  recordedInventoryResources,
} from "../../lib/app-page.ts";
import type { AppHostedResource } from "../../lib/app-hosted-resources.ts";
import { providerConnectionDisplayName } from "../../lib/provider-connections.ts";
import { t } from "../../i18n/index.ts";
import { AppSection } from "./app-ui.tsx";

const ONE_CENT_MICROS = 10_000;

export default function AppCreatedSection(props: {
  readonly inventory?: CapsuleCurrentResourceInventory;
  readonly inventoryLoading: boolean;
  readonly inventoryFailed: boolean;
  readonly bindings: readonly ProviderBinding[];
  readonly connections: readonly ProviderConnection[];
  readonly usage?: CapsuleUsageSummary;
  readonly usageLoading: boolean;
  readonly usageFailed: boolean;
  readonly hosted: readonly AppHostedResource[];
}): JSX.Element {
  const groups = createMemo(() =>
    groupInventoryResources(recordedInventoryResources(props.inventory) ?? []),
  );
  /** The connection(s) a cloud is reached through, by provider source. */
  const connectionNames = (providerSource: string | undefined): string | undefined => {
    if (!providerSource) return undefined;
    const names = props.bindings
      .filter((binding) => sameProviderSource(binding.provider, providerSource))
      .map((binding) => props.connections.find((c) => c.id === binding.connectionId))
      .filter((connection): connection is ProviderConnection => Boolean(connection))
      .map(providerConnectionDisplayName);
    return names.length > 0 ? [...new Set(names)].join(", ") : undefined;
  };
  const cost = createMemo(() =>
    appCostState(props.usage, { loading: props.usageLoading, failed: props.usageFailed }),
  );

  return (
    <AppSection
      id="app-created"
      title={t("app.created.title")}
      subtitle={t("app.created.subtitle")}
      testId="app-created"
    >
      <Switch>
        <Match when={props.inventoryLoading && !props.inventory}>
          <Skeleton variant="row" count={2} />
        </Match>
        <Match when={props.inventoryFailed && !props.inventory}>
          <p class="wa-error" role="alert">{t("app.created.loadFailed")}</p>
        </Match>
        <Match when={props.inventory?.availability === "legacy_unavailable"}>
          <p class="ap-muted">{t("app.created.legacy")}</p>
        </Match>
        <Match when={props.inventory?.availability === "recovery_unknown"}>
          <p class="ap-muted" data-testid="app-created-recovered">{t("app.created.recovered")}</p>
        </Match>
        <Match when={props.inventory?.availability === "recorded" && groups().length === 0}>
          <p class="ap-muted">{t("app.created.empty")}</p>
        </Match>
        <Match when={groups().length > 0}>
          <ul class="ap-clouds" data-testid="app-created-groups">
            <For each={groups()}>
              {(group) => (
                <li class="ap-cloud" data-provider={group.key}>
                  <div class="ap-cloud-head">
                    <strong>{group.label}</strong>
                    <span class="ap-muted">
                      {t("app.created.count", { n: group.total })}
                    </span>
                  </div>
                  <Show when={connectionNames(group.providerSource)}>
                    {(names) => (
                      <p class="ap-muted">{t("app.created.through", { connection: names() })}</p>
                    )}
                  </Show>
                  <ul class="ap-cloud-items">
                    <For each={group.items}>
                      {(item) => (
                        <li>
                          <span>{item.label}</span>
                          <Show when={item.count > 1}>
                            <span class="ap-count">×{item.count}</span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </li>
              )}
            </For>
          </ul>
          <p class="ap-muted">{t("app.created.recordedNote")}</p>
        </Match>
      </Switch>

      <Show when={props.hosted.length > 0}>
        <div class="ap-subsection" data-testid="app-hosted">
          <h3>{t("app.created.hostedTitle")}</h3>
          <ul class="ap-list">
            <For each={props.hosted}>
              {(resource) => (
                <li class="ap-list-row">
                  <div class="ap-list-main">
                    <strong>{resource.name}</strong>
                    <span class="ap-muted">{resource.kind}</span>
                  </div>
                  <Show when={resource.ready !== undefined}>
                    <Badge tone={resource.ready ? "ok" : "warn"}>
                      {resource.ready ? t("app.created.hostedReady") : t("app.created.hostedNotReady")}
                    </Badge>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <div class="ap-subsection" data-testid="app-cost">
        <h3>{t("app.created.costTitle")}</h3>
        <Switch>
          <Match when={cost().kind === "loading"}>
            <Skeleton variant="row" count={1} />
          </Match>
          <Match when={cost().kind === "unavailable"}>
            <p>{t("app.created.costUnavailable")}</p>
          </Match>
          <Match when={cost().kind === "not_recorded"}>
            <p>{t("app.created.costNotRecorded")}</p>
          </Match>
          <Match when={cost().kind === "unrated"}>
            <p>{t("app.created.costUnrated")}</p>
          </Match>
          <Match when={(() => { const value = cost(); return value.kind === "rated" ? value : undefined; })()}>
            {(rated) => (
              <>
                <p class="ap-cost">
                  {t("app.created.costSoFar")}{" "}
                  <strong title={formatUsdMicros(rated().usdMicros)}>
                    {rated().usdMicros > 0 && rated().usdMicros < ONE_CENT_MICROS
                      ? t("app.created.costSubCent")
                      : formatUsdMicros(rated().usdMicros)}
                  </strong>
                  <Show when={rated().usdMicros > 0 && rated().usdMicros < ONE_CENT_MICROS}>
                    <span class="sr-only"> ({formatUsdMicros(rated().usdMicros)})</span>
                  </Show>
                </p>
                <Show when={rated().unratedEventCount > 0}>
                  <p class="ap-muted">
                    {t("app.created.costPartlyUnrated", { n: rated().unratedEventCount })}
                  </p>
                </Show>
              </>
            )}
          </Match>
        </Switch>
        <p class="ap-muted">{t("app.created.costCloudNote")}</p>
      </div>
    </AppSection>
  );
}
