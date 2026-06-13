/**
 * Operator-configured billing plan catalog (spec §32).
 *
 * The hosted offering sells two shapes through Stripe Checkout:
 *   - `subscription` plans — a recurring Stripe price; every paid invoice
 *     grants `credits` to the Space named in the subscription metadata.
 *   - `pack`s — a one-time Stripe price; the completed payment grants
 *     `credits` once.
 *
 * The catalog is operator configuration (`TAKOSUMI_BILLING_PLANS`, a JSON
 * array), NOT data synced from Stripe: the operator decides what is offered
 * and at what display price, and binds each entry to a Stripe price id. The
 * dashboard renders the catalog via `GET /api/v1/billing/plans` (a public
 * projection that omits the Stripe price id) and starts checkout by `planId`;
 * the server resolves the Stripe price + checkout mode + metadata, so a client
 * can never drive checkout against an arbitrary price.
 *
 * POLICY — credits are non-refundable and final (spec §32.3). A purchased
 * grant is never reversed: there is no voluntary refund flow. A chargeback
 * (`charge.dispute.*`) freezes the BillingAccount (status `disputed` →
 * entitlements suspended via `shouldSuspendForBilling`) rather than refunding
 * credits, so "reversing the purchase also stops usage" — the credit balance
 * itself is not reversed.
 */

export interface BillingPlanText {
  readonly ja: string;
  readonly en: string;
}

export interface BillingPlan {
  /** Stable operator-chosen id (`plan_code` in Stripe metadata). */
  readonly id: string;
  readonly kind: "subscription" | "pack";
  /** The Stripe price this plan checks out (server-side only). */
  readonly stripePriceId: string;
  /** Credits granted per paid invoice (subscription) or per purchase (pack). */
  readonly credits: number;
  readonly name: BillingPlanText;
  /** Display price ("¥1,000 / 月" etc.) — presentation only, Stripe charges. */
  readonly priceDisplay: BillingPlanText;
}

/** Public projection served to the dashboard (no Stripe price id). */
export type PublicBillingPlan = Omit<BillingPlan, "stripePriceId">;

export function publicBillingPlans(
  plans: readonly BillingPlan[],
): readonly PublicBillingPlan[] {
  return plans.map(({ stripePriceId: _stripePriceId, ...rest }) => rest);
}

export function findBillingPlan(
  plans: readonly BillingPlan[],
  id: string,
): BillingPlan | undefined {
  return plans.find((plan) => plan.id === id);
}

/**
 * Parses the operator catalog JSON. Fail-soft per entry: a malformed entry is
 * skipped with a structured log line (an operator typo must not take the whole
 * billing surface down), an unparsable document yields an empty catalog.
 */
export function parseBillingPlans(
  raw: string | undefined,
): readonly BillingPlan[] {
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      "billing_plans_invalid",
      JSON.stringify({ reason: "not_json" }),
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(
      "billing_plans_invalid",
      JSON.stringify({ reason: "not_array" }),
    );
    return [];
  }
  const plans: BillingPlan[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const plan = parsePlanEntry(entry);
    if (!plan) {
      console.error(
        "billing_plans_invalid",
        JSON.stringify({ reason: "bad_entry", index }),
      );
      continue;
    }
    if (seen.has(plan.id)) {
      console.error(
        "billing_plans_invalid",
        JSON.stringify({ reason: "duplicate_id", id: plan.id }),
      );
      continue;
    }
    seen.add(plan.id);
    plans.push(plan);
  }
  return plans;
}

function parsePlanEntry(entry: unknown): BillingPlan | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const id = nonEmptyString(record.id);
  const kind = record.kind === "subscription" || record.kind === "pack"
    ? record.kind
    : undefined;
  const stripePriceId = nonEmptyString(record.stripePriceId);
  const credits = typeof record.credits === "number" &&
      Number.isSafeInteger(record.credits) && record.credits > 0
    ? record.credits
    : undefined;
  const name = localizedText(record.name);
  const priceDisplay = localizedText(record.priceDisplay);
  if (!id || !kind || !stripePriceId || !credits || !name || !priceDisplay) {
    return undefined;
  }
  return { id, kind, stripePriceId, credits, name, priceDisplay };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function localizedText(value: unknown): BillingPlanText | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const ja = nonEmptyString(record.ja);
  const en = nonEmptyString(record.en);
  if (!ja || !en) return undefined;
  return { ja, en };
}
