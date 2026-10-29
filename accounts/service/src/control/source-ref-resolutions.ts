import { errorJson, json, methodNotAllowed, stringValue } from "../http-helpers.ts";
import type { ControlDispatchContext } from "./shared.ts";

/** Resolve a public Git source's current stable SemVer tag for account callers. */
export async function handleSourceRefResolutions(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments.length !== 1 || segments[0] !== "source-ref-resolutions") return undefined;
  if (method !== "GET") return methodNotAllowed("GET");
  if (ctx.session.workspaceId !== undefined || ctx.session.appIds !== undefined) {
    return errorJson("app_access_denied", "An account credential is required.", 403, ctx.request);
  }
  const url = stringValue(ctx.url.searchParams.get("url") ?? undefined);
  if (!url || [...ctx.url.searchParams.keys()].some((key) => key !== "url")) {
    return errorJson("invalid_request", "url is required", 400, ctx.request);
  }
  return json(await ctx.operations.resolveStableSourceTag(url));
}
