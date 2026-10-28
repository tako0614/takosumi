/**
 * The structured reasons a policy blocked a plan or made it wait for an
 * approval, as readable lines with the provider or resource type each one
 * names. Shared by the run page, the app page's problems and its history.
 */
import { For, type JSX, Show } from "solid-js";
import type { RunPolicyReason } from "../../lib/control-api.ts";
import { isApprovalReason, policyReasonLine } from "../../lib/policy-reasons.ts";
import { t } from "../../i18n/index.ts";

export default function PolicyReasonList(props: {
  readonly reasons: readonly RunPolicyReason[];
  /** Overrides the default heading; `false` renders the list alone. */
  readonly title?: string | false;
  readonly class?: string;
}): JSX.Element {
  const lines = () => props.reasons.map(policyReasonLine);
  // Reasons that only ask for an approval read as such, not as a block.
  const heading = () =>
    props.title ||
    (props.reasons.every(isApprovalReason) ? t("policy.approvalTitle") : t("policy.reasonsTitle"));
  return (
    <Show when={props.reasons.length > 0}>
      <div class={`policy-reasons${props.class ? ` ${props.class}` : ""}`} data-testid="policy-reasons">
        <Show when={props.title !== false}>
          <p class="policy-reasons-title">{heading()}</p>
        </Show>
        <ul>
          <For each={lines()}>
            {(line) => (
              <li data-policy-fallback={line.fallback ? "true" : undefined}>
                <span>{line.text}</span>
                <Show when={line.provider}>
                  {(provider) => (
                    <span class="policy-reason-subject">
                      {t("policy.subject.provider")} <code>{provider()}</code>
                    </span>
                  )}
                </Show>
                <Show when={line.resourceType}>
                  {(type) => (
                    <span class="policy-reason-subject">
                      {t("policy.subject.resourceType")} <code>{type()}</code>
                    </span>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
