/**
 * Reviewable list of a plan's resource changes (Run `planResources`): one row
 * per create / update / replace / delete with a plain display label, and the
 * raw address / type / scope folded behind "Reference IDs". No-op rows are
 * dropped and the whole list renders nothing when no row changes anything.
 * Long plans show the first PLAN_RESOURCE_REVIEW_LIMIT rows until expanded.
 */
import "../../styles/wave-a.css";
import "../../styles/wave-b.css";
import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import type { RunPlanResource } from "../../lib/control-api.ts";
import {
  PLAN_RESOURCE_REVIEW_LIMIT,
  planResourceActionLabel,
  planResourceDisplayLabel,
  planResourceScopeLabel,
  planResourceTone,
  reviewablePlanResources,
} from "../../lib/run-plan-resources.ts";
import { Badge, Button } from "../ui/index.ts";

export interface PlanResourceListProps {
  readonly resources: readonly RunPlanResource[];
  /** Order rows create → update → replace → delete instead of plan order. */
  readonly sortByAction?: boolean;
}

export default function PlanResourceList(props: PlanResourceListProps) {
  const actionable = () =>
    reviewablePlanResources(props.resources, {
      sortByAction: props.sortByAction,
    });
  const [expanded, setExpanded] = createSignal(false);
  const visible = () =>
    expanded()
      ? actionable()
      : actionable().slice(0, PLAN_RESOURCE_REVIEW_LIMIT);
  const hiddenCount = () =>
    expanded()
      ? 0
      : Math.max(0, actionable().length - PLAN_RESOURCE_REVIEW_LIMIT);
  return (
    <Show when={actionable().length > 0}>
      <div class="wa-plan-resources">
        <div class="wa-plan-resources-head">
          <div>
            <p class="wa-section-kicker">{t("run.resources.kicker")}</p>
            {/* h2, not h3: the page h1 is the only heading above this one. */}
            <h2>{t("run.resources.title")}</h2>
          </div>
          <Badge tone="muted">
            {t("run.resources.count", { n: actionable().length })}
          </Badge>
        </div>
        <div class="wa-plan-resource-list">
          <For each={visible()}>
            {(resource) => (
              <div class="wa-plan-resource-row">
                <Badge tone={planResourceTone(resource)}>
                  {planResourceActionLabel(resource)}
                </Badge>
                <div class="wa-plan-resource-main">
                  <strong>{planResourceDisplayLabel(resource)}</strong>
                  <details class="wb-inline-details">
                    <summary>{t("run.resources.identifiers")}</summary>
                    <p>
                      <span class="muted">{t("run.resources.address")}</span>{" "}
                      <code>{resource.address}</code>
                    </p>
                    <p>
                      <span class="muted">{t("run.resources.type")}</span>{" "}
                      <code>{resource.type}</code>
                    </p>
                    <Show when={planResourceScopeLabel(resource.scope)}>
                      {(scope) => (
                        <p class="wa-plan-resource-scope">
                          <span class="muted">{t("run.resources.scope")}</span>{" "}
                          {scope()}
                        </p>
                      )}
                    </Show>
                  </details>
                </div>
              </div>
            )}
          </For>
        </div>
        <Show when={hiddenCount() > 0}>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setExpanded(true)}
          >
            {t("run.resources.more", { n: hiddenCount() })}
          </Button>
        </Show>
      </div>
    </Show>
  );
}
