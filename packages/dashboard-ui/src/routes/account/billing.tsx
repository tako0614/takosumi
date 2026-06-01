import { Title } from "@solidjs/meta";
import { CreditCard, ExternalLink } from "lucide-solid";
import { createSignal, Show } from "solid-js";
import AppShell from "~/components/shell/AppShell";
import AuthGuard from "~/components/auth/AuthGuard";
import { startStripeCheckout } from "~/lib/api/billing";
import { ApiError } from "~/lib/api/client";

/**
 * Origins that Stripe checkout / billing portal redirect URLs are
 * permitted to use. The server-side `billingRedirectAllowlist` policy
 * is the authoritative gate, but checking client-side first avoids
 * `location.assign`-ing to whatever string the API (or a
 * man-in-the-middle response rewriter) happened to return.
 */
const STRIPE_CHECKOUT_ALLOWED_ORIGINS = [
  "https://checkout.stripe.com",
  "https://billing.stripe.com",
] as const;

export function isAllowedStripeRedirect(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return STRIPE_CHECKOUT_ALLOWED_ORIGINS.includes(
    parsed.origin as (typeof STRIPE_CHECKOUT_ALLOWED_ORIGINS)[number],
  );
}

export default function Billing() {
  return (
    <>
      <Title>Billing — Takosumi</Title>
      <AuthGuard>{() => <Inner />}</AuthGuard>
    </>
  );
}

function Inner() {
  const [planId, setPlanId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = createSignal<string | null>(null);

  const start = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const result = await startStripeCheckout({
        planId: planId() || undefined,
        successUrl: location.origin + "/account/billing?status=success",
        cancelUrl: location.origin + "/account/billing?status=cancelled",
      });
      if (!result.url) {
        setErr("Stripe checkout URL が返ってきませんでした。");
        return;
      }
      if (!isAllowedStripeRedirect(result.url)) {
        setErr(
          "Stripe checkout URL が許可されたオリジン (checkout.stripe.com / billing.stripe.com) と一致しません。",
        );
        return;
      }
      setCheckoutUrl(result.url);
      location.assign(result.url);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>Billing</h1>
        <p class="page-sub">Stripe 経由のサブスクリプション開始 / 履歴。</p>
      </div>

      <section class="detail-section">
        <h2>
          <CreditCard size={18} /> サブスクリプション
        </h2>
        <p class="muted">
          Stripe Checkout で新規プランを開始します。 planId は任意で、
          設定済みのデフォルトプランが使われます。
        </p>
        <form class="install-form" onSubmit={start}>
          <label>
            Plan ID (任意)
            <input
              type="text"
              value={planId()}
              onInput={(e) => setPlanId(e.currentTarget.value)}
              placeholder="price_xxxx (任意)"
              autocomplete="off"
            />
          </label>
          <button class="btn btn-primary" type="submit" disabled={busy()}>
            <ExternalLink size={16} />{" "}
            {busy() ? "リダイレクト準備中..." : "Stripe Checkout へ"}
          </button>
        </form>
        <Show when={err()}>{(m) => <p class="sign-in-error">{m()}</p>}</Show>
        <Show when={checkoutUrl()}>
          {(u) => (
            <p class="muted" style="margin-top: 8px;">
              自動リダイレクトしない場合は{" "}
              <a href={u()} rel="external">
                こちら
              </a>{" "}
              から手動で開いてください。
            </p>
          )}
        </Show>
      </section>

      <section class="detail-section">
        <h2>請求履歴</h2>
        <p class="muted">
          請求履歴は、このアカウントで利用できる請求情報が作成されるとここに表示されます。
        </p>
      </section>
    </AppShell>
  );
}
