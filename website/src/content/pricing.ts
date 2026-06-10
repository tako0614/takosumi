/**
 * Pricing / ownership facts — written fact-first, no invented numbers.
 *
 * Two honest tiers:
 *  - Self-host: free & open source. The control plane ships a billing
 *    "disabled" mode (BillingMode = "disabled" in packages/schema/src/billing.ts),
 *    so there is no charging machinery at all — you `tofu apply` onto your own
 *    infrastructure and own it.
 *  - Managed: credit-based. The model exists (showback / enforce modes, managed
 *    credits with a per-run apply reservation), but the actual prices and the
 *    credit-cost formula are a product decision and are intentionally withheld
 *    here ("ローンチ時に案内"). Do NOT invent numbers.
 */

export interface PlanFeature {
  readonly label: string;
}

export interface PricingPlan {
  readonly id: "self-host" | "managed";
  readonly name: string;
  /** Short, honest price line. Never a fabricated number. */
  readonly price: string;
  readonly priceNote: string;
  readonly tagline: string;
  readonly features: readonly PlanFeature[];
  readonly cta: { readonly label: string; readonly href: string };
  readonly highlight?: boolean;
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: "self-host",
    name: "自分で動かす (self-host)",
    price: "無料",
    priceNote: "open source。課金の仕組みそのものが入っていません。",
    tagline: "あなたのインフラに、あなたが置く。",
    features: [
      { label: "OpenTofu module を自分のインフラに tofu apply するだけ" },
      { label: "サーバー代はあなたが直接 cloud に払う (Takosumi には払わない)" },
      { label: "課金画面も従量課金もなし。止める人も値上げする人もいない" },
      { label: "すべて open source。中身を読める・直せる・引っ越せる" },
    ],
    cta: { label: "self-host を読む", href: "/docs/" },
  },
  {
    id: "managed",
    name: "おまかせで動かす (managed)",
    price: "ローンチ時に案内",
    priceNote: "credit ベース。具体的な金額は公開準備中です。",
    tagline: "インフラも運用も、こちらで。",
    features: [
      { label: "host も運用も Takosumi 側が持つ。あなたは module を選ぶだけ" },
      { label: "クレジット制 — apply する前に必要量を見積もって確保します" },
      { label: "まず使用量を見せるだけのモード、止めずに運用も選べます" },
      { label: "残高が足りなければ承認の前で止まり、勝手に課金されません" },
    ],
    cta: { label: "案内を待つ", href: "https://app.takosumi.com/" },
    highlight: true,
  },
];

/**
 * Plain-language "who owns what" contrast, kept separate from the price cards.
 * No internal vocabulary surfaced as the primary label.
 */
export interface OwnershipRow {
  readonly axis: string;
  readonly selfHost: string;
  readonly managed: string;
}

export const OWNERSHIP_ROWS: readonly OwnershipRow[] = [
  {
    axis: "インフラの持ち主",
    selfHost: "あなた (自分の cloud / VM / cluster)",
    managed: "Takosumi が用意した host",
  },
  {
    axis: "運用するのは誰",
    selfHost: "あなた自身",
    managed: "Takosumi 側",
  },
  {
    axis: "支払い先",
    selfHost: "cloud 事業者へ直接 (Takosumi へは無料)",
    managed: "Takosumi へクレジットで",
  },
  {
    axis: "始め方",
    selfHost: "module を tofu apply するだけ",
    managed: "サインアップして使うだけ",
  },
  {
    axis: "中身",
    selfHost: "どちらも同じ open source。台帳も Run の形も共通",
    managed: "どちらも同じ open source。台帳も Run の形も共通",
  },
];
