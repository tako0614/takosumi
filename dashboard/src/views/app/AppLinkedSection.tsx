/**
 * Linked apps: the apps this app uses and the apps that use it. Shown only
 * when there is at least one link; uninstalling names the apps that use it.
 */
import { For, type JSX, Show } from "solid-js";
import type { LinkedApp } from "../../lib/app-page.ts";
import { t } from "../../i18n/index.ts";
import { AppSection } from "./app-ui.tsx";

export default function AppLinkedSection(props: {
  readonly uses: readonly LinkedApp[];
  readonly usedBy: readonly LinkedApp[];
}): JSX.Element {
  return (
    <AppSection id="app-linked" title={t("app.linked.title")} testId="app-linked">
      <div class="ap-linked">
        <Show when={props.uses.length > 0}>
          <LinkedList title={t("app.linked.uses")} apps={props.uses} />
        </Show>
        <Show when={props.usedBy.length > 0}>
          <LinkedList title={t("app.linked.usedBy")} apps={props.usedBy} />
        </Show>
      </div>
    </AppSection>
  );
}

function LinkedList(props: { readonly title: string; readonly apps: readonly LinkedApp[] }) {
  return (
    <div>
      <h3>{props.title}</h3>
      <ul class="ap-linked-list">
        <For each={props.apps}>
          {(app) => (
            <li>
              <a href={`/workloads/${encodeURIComponent(app.capsuleId)}`}>{app.name}</a>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
