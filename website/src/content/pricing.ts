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
    name: "自分で動かす (セルフホスト)",
    price: "無料",
    priceNote: "オープンソース。課金の仕組みそのものが入っていません。",
    tagline: "あなたのインフラに、あなたが置く。",
    features: [
      {
        label:
          "自分の環境で Takosumi を動かし、deploy の設定も実行記録も自分で持つ",
      },
      {
        label: "サーバー代はあなたが直接クラウドに払う (Takosumi には払わない)",
      },
      { label: "課金画面も従量課金もなし。止める人も値上げする人もいない" },
      { label: "すべてオープンソース。中身を読める・直せる・引っ越せる" },
    ],
    cta: { label: "セルフホストガイド", href: "/docs/" },
  },
  {
    id: "platform",
    name: "Takosumi Cloud",
    price: "ローンチ時に案内",
    priceNote: "クレジットベース。一般公開と金額はローンチ時に案内します。",
    tagline: "公式ホスティング版。セットアップ不要ですぐ使えます。",
    features: [
      { label: "一般公開はローンチ時に案内します" },
      { label: "クレジット制 — 実行する前に必要量を見積もって確保します" },
      { label: "まず使用量を見せるだけのモード、止めずに運用も選べます" },
      { label: "残高が足りなければ承認の前で止まり、勝手に課金されません" },
    ],
    cta: { label: "ローンチ情報を見る", href: "/docs/" },
    highlight: true,
  },
];
