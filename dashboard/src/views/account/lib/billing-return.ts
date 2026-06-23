export type BillingCheckoutNotice = "success" | "cancelled";

const BILLING_RETURN_PATH = "/billing";
const SPACE_ID_PARAM = "spaceId";

export function buildBillingReturnUrl(input: {
  readonly origin: string;
  readonly checkout: BillingCheckoutNotice;
  readonly spaceId: string;
}): string {
  const url = new URL(BILLING_RETURN_PATH, input.origin);
  url.searchParams.set("checkout", input.checkout);
  const spaceId = normalizeBillingReturnSpaceId(input.spaceId);
  if (spaceId) url.searchParams.set(SPACE_ID_PARAM, spaceId);
  return url.toString();
}

export function consumeBillingReturnSearch(search: string): {
  readonly checkoutNotice: BillingCheckoutNotice | null;
  readonly spaceId: string | null;
  readonly nextSearch: string;
  readonly changed: boolean;
} {
  const params = new URLSearchParams(search);
  const rawCheckout = params.get("checkout");
  const checkoutNotice =
    rawCheckout === "success" || rawCheckout === "cancelled"
      ? rawCheckout
      : null;
  const spaceId = normalizeBillingReturnSpaceId(params.get(SPACE_ID_PARAM));
  const changed =
    params.has("checkout") ||
    params.has("portal") ||
    params.has(SPACE_ID_PARAM);

  params.delete("checkout");
  params.delete("portal");
  params.delete(SPACE_ID_PARAM);

  return {
    checkoutNotice,
    spaceId,
    nextSearch: params.toString(),
    changed,
  };
}

function normalizeBillingReturnSpaceId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^space_[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}
