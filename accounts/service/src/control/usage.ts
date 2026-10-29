import { errorJson, json, methodNotAllowed } from "../http-helpers.ts";
import { controlPlaneUnavailable, parseControlPageParams, type ControlDispatchContext } from "./shared.ts";

export async function handleUsage(ctx: ControlDispatchContext, segments: readonly string[], method: string): Promise<Response | undefined> {
  if (segments[0] !== "usage" || segments.length !== 1) return undefined;
  if (method !== "GET") return methodNotAllowed("GET");
  if (ctx.session.workspaceId !== undefined || ctx.session.appIds !== undefined) {
    return errorJson("app_access_denied", "An account credential is required to read payer usage.", 403, ctx.request);
  }
  const page = parseControlPageParams(ctx.url);
  if (!page.ok) return page.response;
  if (!ctx.operations.accountResources) return controlPlaneUnavailable();
  try {
    const result = await ctx.operations.accountResources.listUsage(ctx.session.subject, page.params);
    return json({ usageEvents: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
  } catch (error) {
    // Additive route remains closed until the v77 physical payer column exists.
    if (error instanceof Error && /(?:no such column|column .* does not exist).*payer_account_id|payer_account_id.*does not exist/iu.test(error.message)) return controlPlaneUnavailable();
    throw error;
  }
}
