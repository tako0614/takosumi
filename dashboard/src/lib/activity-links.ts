/**
 * Where an activity event goes when you click it.
 *
 * Shared by /notifications and /activity: the history page used to render the
 * same events as plain, unclickable text, so a failure you found there was a
 * dead end while the identical row on /notifications linked straight to the
 * run. Connection, output-share and Interface-publication events route to the
 * pages that act on them.
 */
import type { ActivityEvent } from "./control-api.ts";

export function activityEventHref(event: ActivityEvent): string | undefined {
  if (event.targetType === "run") {
    return `/runs/${encodeURIComponent(event.targetId)}`;
  }
  if (event.targetType === "run_group") {
    return `/run-groups/${encodeURIComponent(event.targetId)}`;
  }
  if (event.targetType === "capsule") {
    return `/workloads/${encodeURIComponent(event.targetId)}`;
  }
  if (event.targetType === "connection") {
    return "/connections";
  }
  if (event.targetType === "output_share") {
    return "/advanced/workspace/shares";
  }
  if (event.targetType === "capsule_interface_materialization_intent") {
    // A dead-lettered Interface publication is retried only from the
    // Workspace's Interface recovery list.
    return "/advanced/workspace/interface-recovery";
  }
  return undefined;
}
