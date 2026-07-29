/**
 * Pricing / ownership facts. Takosumi Cloud has no subscription tier or fixed
 * monthly fee. Customers add prepaid credits and pay the published usage
 * prices; automatic recharge is an explicit, default-off owner setting.
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
    name: "Takosumi Cloud",
    price: "月額固定費なし",
    priceNote:
      "$5 からプリペイドクレジットを追加。自動チャージは初期状態で無効です。",
    tagline: "公式ホスティング版。セットアップ不要ですぐ使えます。",
    features: [
      { label: "公式ホスティング。ブラウザからサービスを追加・更新できます" },
      {
        label:
          "最初の $0.25 クレジットを使った後は、公開された従量単価で利用分だけ支払います",
      },
      {
        label:
          "自動チャージは任意。残高しきい値、1回の金額、月間上限を自分で設定できます",
      },
      {
        label:
          "残高不足や設定上限を超える操作は、バックエンド実行前に停止します",
      },
    ],
    cta: { label: "Cloud を開く", href: "https://app.takosumi.com/" },
    highlight: true,
  },
];
