/**
 * Where an activity event goes when you click it.
 *
 * Used by the notification feed. Run events open the run, app events open
 * the app's page, and connection events open 接続. Events about things that
 * live on an app's page (a screen that could not be published) open ホーム,
 * which lists the app with what needs attention. Value sharing between workspaces
 * has no screen, so its events are not links.
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
  if (event.targetType === "capsule_interface_materialization_intent") {
    // The event targets the publication intent, not the app; the app's page
    // owns the retry and ホーム shows which app needs attention.
    const capsuleId = event.metadata?.capsuleId;
    return typeof capsuleId === "string" && capsuleId
      ? `/workloads/${encodeURIComponent(capsuleId)}`
      : "/";
  }
  return undefined;
}
