import type { ControlDispatchContext } from "./shared.ts";
import { json, methodNotAllowed } from "../http-helpers.ts";

export async function handleBilling(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (
    segments.length === 2 &&
    segments[0] === "billing" &&
    segments[1] === "plans"
  ) {
    if (method !== "GET" && method !== "HEAD")
      return methodNotAllowed("GET, HEAD");
    return json({
      plans: (ctx.publicBillingPlans ?? []).map(publicBillingPlan),
    });
  }
  return undefined;
}

function publicBillingPlan(
  plan: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { stripePriceId: _stripePriceId, ...publicPlan } = plan;
  return publicPlan;
}
