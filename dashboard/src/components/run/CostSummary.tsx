/**
 * Pre-apply cost / shortfall panel — backend-computed values only.
 *
 * Renders one {@link RunCostDisplayState} (lib/run-cost.ts): a positive
 * estimate, an explicit "unrated" line for measured-but-unpriced usage, and an
 * explicit "unavailable" line when the cost read failed — an unknown cost is
 * never presented as free. A rated zero or a billing-disabled workspace has no
 * line of its own, so the panel then renders only for a blocked decision (and
 * nothing at all otherwise).
 */
import "../../styles/wave-a.css";
import { For, Match, Show, Switch } from "solid-js";
import { t } from "../../i18n/index.ts";
import { hasPlatformExtensionCapability } from "../../lib/runtime-capabilities.ts";
import {
  formatUsdMicros,
  runCostDisplayHasContent,
  type RunCostDisplayState,
} from "../../lib/run-cost.ts";
import { Button } from "../ui/index.ts";

export interface CostSummaryProps {
  readonly state: RunCostDisplayState;
}

export default function CostSummary(props: CostSummaryProps) {
  const cost = () =>
    props.state.kind === "unavailable" ? undefined : props.state.cost;
  const estimatedUsdMicros = () =>
    props.state.kind === "estimated" ? props.state.estimatedUsdMicros : 0;
  // The host's structured decision, never inferred from error-code prefixes.
  const blocked = () => cost()?.blocked === true;
  const reasons = () => cost()?.reasons ?? [];
  const commercialBilling = () =>
    hasPlatformExtensionCapability("billing.commercial.v1");
  return (
    <Show when={runCostDisplayHasContent(props.state)}>
      <div class={`wa-cost${blocked() ? " wa-cost-blocked" : ""}`}>
        <Switch>
          <Match when={props.state.kind === "unavailable"}>
            <p class="wa-cost-line">{t("run.cost.unavailable")}</p>
          </Match>
          <Match when={props.state.kind === "unrated"}>
            <p class="wa-cost-line">{t("run.cost.unrated")}</p>
          </Match>
          <Match when={estimatedUsdMicros() > 0}>
            <p class="wa-cost-line">
              {t("run.cost.required", {
                n: formatUsdMicros(estimatedUsdMicros()),
              })}
            </p>
          </Match>
        </Switch>
        <Show when={blocked()}>
          <p class="wa-error">{t("run.cost.capacityBlocked")}</p>
          <Show when={reasons().length > 0}>
            <ul class="wa-cost-reasons">
              <For each={reasons()}>{(reason) => <li>{reason}</li>}</For>
            </ul>
          </Show>
          <Show
            when={commercialBilling()}
            fallback={
              <>
                <p class="muted">{t("run.cost.operatorHelp")}</p>
                <Button variant="secondary" size="sm" href="/account/billing">
                  {t("run.cost.quotaCta")}
                </Button>
              </>
            }
          >
            <Button variant="secondary" size="sm" href="/account/billing">
              {t("run.cost.billingCta")}
            </Button>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
