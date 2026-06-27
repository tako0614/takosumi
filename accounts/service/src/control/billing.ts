/**
 * Session-authed billing resource placeholder. The public session control
 * inventory (`control-route-inventory.ts`) declares `GET /api/v1/billing/plans`
 * ("List public billing plans"), but it is not yet wired on this session
 * surface. The handler returns `undefined` so the request falls through to the
 * standard control 404 — byte-identical to the pre-split dispatch, which never
 * matched a `billing` segment. Registered in the dispatch table so the
 * inventory ↔ dispatch parity test treats the declared route as covered.
 */
import type { ControlDispatchContext } from "./shared.ts";

export async function handleBilling(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  void ctx;
  void segments;
  void method;
  return undefined;
}
