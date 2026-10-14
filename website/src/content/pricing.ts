/**
 * Adopted launch pricing. Shared login and billing are awaiting activation;
 * the authenticated service determines current availability. Takoserver owns
 * the shared price revision and one Organization wallet for both products.
 * Internal allowance, payment-provider IDs, cost estimates, and readiness
 * evidence stay in operator-private state.
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
  readonly features: readonly PlanFeature[];
  readonly cta: { readonly label: string; readonly href: string };
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: "self-host",
    name: "自分で動かす (セルフホスト)",
    price: "無料",
    priceNote: "オープンソース。Takosumi への利用料はありません。",
    features: [
      {
        label:
          "自分の環境で Takosumi を動かし、デプロイの設定も実行記録も自分で持ちます",
      },
      {
        label: "サーバー代は、あなたがクラウドに直接払います (Takosumi には払いません)",
      },
      { label: "課金画面も従量課金もありません。止める人も、値上げする人もいません" },
      { label: "すべてオープンソース。中身を読めて、直せて、引っ越せます" },
    ],
    cta: { label: "セルフホストガイド", href: "/docs/" },
  },
  {
    id: "platform",
    name: "Takosumi Hosted（ローンチ予定）",
    price: "Free / 月額 $10・$50",
    priceNote:
      "Free は $1.50/月分。有料プランは $10 で $20、$50 で $100 の利用枠。税別 USD。",
    features: [
      { label: "Free はカード不要。有料プランに Free の利用枠は加算しません" },
      {
        label:
          "Takoserver と共通の Organization 残高を利用し、Workspace 別に利用量を確認します",
      },
      {
        label:
          "従量料金は供給側の Cloudflare 単価の3倍。top-up は支払額と同額です",
      },
      {
        label:
          "80%・95%で警告し、上限到達時は停止が初期値。有料継続は明示的に選びます",
      },
      { label: "共通ログインと課金の切り替え・staging 検証は進行中です" },
    ],
    cta: { label: "ローンチ料金を見る", href: "https://app.takosumi.com/docs/pricing" },
  },
];
