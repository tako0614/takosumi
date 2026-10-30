// Imports the real composed platform worker only for its module-scope
// hookup of the runtime's per-invocation waitUntil, then records notified
// events through the real observer with a timer standing in for delivery.
import platformWorker from "../../../../deploy/platform/worker.ts";
import {
  invocationWaitUntilAttached,
  ownNotificationActivityObserver,
} from "../../../../worker/src/own_notification_dispatch.ts";

const log: string[] = [];
const observe = ownNotificationActivityObserver(() => ({}) as never, {
  deliver: async (_target, event) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    log.push(`done:${event.id}`);
  },
});

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/state") {
      return Response.json({
        attached: invocationWaitUntilAttached(),
        platformFetch: typeof platformWorker.fetch,
        log,
      });
    }
    const id = url.searchParams.get("id") ?? "act";
    observe({
      id,
      workspaceId: "ws",
      action: "run.approval_required",
      targetType: "run",
      targetId: `run_${id}`,
      runId: `run_${id}`,
      metadata: { capsuleId: "cap_1" },
      createdAt: new Date().toISOString(),
    });
    return Response.json({ attached: invocationWaitUntilAttached() });
  },
};
