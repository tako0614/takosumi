/**
 * Pricing / ownership facts. Public numbers mirror the operator plan specs:
 * Starter is JPY 980/month with a $3.00 Takosumi Cloud balance grant; an extra
 * $5.00 balance pack is JPY 1,200. Stripe IDs, net-revenue estimates, and
 * readiness evidence stay in operator-private state.
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
    price: "月額980円",
    priceNote:
      "$3.00 残高付き。追加の $5.00 残高パックは 1,200円。無料枠あり。",
    tagline: "公式ホスティング版。セットアップ不要ですぐ使えます。",
    features: [
      { label: "公式ホスティング。ブラウザからサービスを追加・更新できます" },
      { label: "USD 残高制 — Cloud リソース使用量を細かく差し引きます" },
      {
        label: "無料枠は上限付き。残高がなくなると Cloud リソースは止まります",
      },
      {
        label: "料金表は Takosumi Cloud が決め、原価割れしない単価で運用します",
      },
    ],
    cta: { label: "Cloud を開く", href: "https://app.takosumi.com/" },
    highlight: true,
  },
];
