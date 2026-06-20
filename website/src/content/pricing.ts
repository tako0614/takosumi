/**
 * Pricing / ownership facts — written fact-first, no invented numbers.
 *
 * Two honest paths:
 *  - Self-host: free & open source. The control plane ships a billing
 *    "disabled" mode (BillingMode = "disabled" in contract/billing.ts),
 *    so there is no charging machinery at all — you `tofu apply` onto your own
 *    infrastructure and own it.
 *  - Takosumi Cloud: credit-based official hosting. The model exists
 *    (showback / enforce modes, credits with a per-run apply reservation), but public
 *    access, actual prices, and the credit-cost formula depend on operator
 *    evidence and are intentionally withheld here ("ローンチ時に案内"). Do NOT
 *    invent numbers.
 */

export interface PlanFeature {
  readonly label: string;
}

export interface PricingPlan {
  readonly id: "self-host" | "platform";
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
      {
        label:
          "自分の環境で Takosumi を動かし、Capsule と Run 台帳を自分で持つ",
      },
      {
        label: "サーバー代はあなたが直接 cloud に払う (Takosumi には払わない)",
      },
      { label: "課金画面も従量課金もなし。止める人も値上げする人もいない" },
      { label: "すべて open source。中身を読める・直せる・引っ越せる" },
    ],
    cta: { label: "self-host を読む", href: "/docs/" },
  },
  {
    id: "platform",
    name: "Takosumi Cloud",
    price: "ローンチ時に案内",
    priceNote: "credit ベース。公開 access と金額はローンチ時に案内します。",
    tagline: "公式ホスティング版 Takosumi for Operators。",
    features: [
      { label: "公開 access はローンチ時に案内します" },
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
  readonly platform: string;
}

export const OWNERSHIP_ROWS: readonly OwnershipRow[] = [
  {
    axis: "インフラの持ち主",
    selfHost: "あなた (自分の cloud / VM / cluster)",
    platform: "platform operator が用意した host",
  },
  {
    axis: "運用するのは誰",
    selfHost: "あなた自身",
    platform: "platform operator",
  },
  {
    axis: "支払い先",
    selfHost: "cloud 事業者へ直接 (Takosumi へは無料)",
    platform: "platform operator へクレジットで",
  },
  {
    axis: "始め方",
    selfHost: "自分の Takosumi で Git URL Capsule を登録",
    platform: "公開後はサインアップして Git URL Capsule を登録",
  },
  {
    axis: "中身",
    selfHost: "どちらも同じ open source。台帳も Run の形も共通",
    platform: "どちらも同じ open source。台帳も Run の形も共通",
  },
];
