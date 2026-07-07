/**
 * Pricing / ownership facts. Public numbers mirror the operator plan specs:
 * Takosumi Cloud has subscription tiers starting at $1/month. Internal
 * allowance, Stripe IDs, net-revenue estimates, and readiness evidence stay in
 * operator-private state.
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
    priceNote: "オープンソース。Takosumi への利用料はありません。",
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
    price: "月額 $1 から",
    priceNote: "Lite / Plus / Pro。どのプランも月額と従量課金の組み合わせです。",
    tagline: "公式ホスティング版。セットアップ不要ですぐ使えます。",
    features: [
      { label: "公式ホスティング。ブラウザからサービスを追加・更新できます" },
      { label: "AI サービスのように、プランと従量課金で利用量を管理します" },
      {
        label: "使いすぎを防ぐため、上限や支払い設定に応じて実行前に止まります",
      },
      {
        label: "料金表は Takosumi Cloud が決め、原価割れしない単価で運用します",
      },
    ],
    cta: { label: "Cloud を開く", href: "https://app.takosumi.com/" },
    highlight: true,
  },
];
