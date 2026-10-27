import { For, Show } from "solid-js";
import { Badge } from "../../components/ui/index.ts";
import type { CapsuleCompatibilityResource } from "../../lib/control-api.ts";
import { t } from "../../i18n/index.ts";

/**
 * What the app's definition declares it will create, read from the scanned
 * module before any connection or Plan exists. Resource types are shown as
 * the definition names them: this is the honest preview, and the exact
 * create/update/delete list replaces it once the Plan is ready.
 */
export function PlannedResources(props: {
  readonly resources: readonly CapsuleCompatibilityResource[];
}) {
  return (
    <Show
      when={props.resources.length > 0}
      fallback={<p class="iv-muted">{t("installStore.plannedEmpty")}</p>}
    >
      <ul class="iv-planned-resources">
        <For each={props.resources}>
          {(resource) => (
            <li data-resource-type={resource.type}>
              <code>{resource.type}</code>
              <Show when={resource.count !== undefined && resource.count > 1}>
                <span class="iv-planned-count">×{resource.count}</span>
              </Show>
              <Show when={!resource.allowed}>
                <Badge tone="warn">{t("installStore.plannedNotAllowed")}</Badge>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
