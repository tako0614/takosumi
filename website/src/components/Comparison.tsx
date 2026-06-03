/**
 * 3 列 audience-aware comparison (Wave M-H3 訂正後)。
 * SaaS = Notion / Slack / Google Docs 等 (= 非技術者にも届く対比軸)、
 * Vendor PaaS = Heroku / Render 等。 旧「素の cloud」「Terraform」 列は
 * 削除 (= 非技術者には伝わらない + WhyOperatorOwned で本質は語り済)。
 */
import SplatField from "./SplatField";

const ROWS = [
  {
    axis: "データの所在",
    us: "あなたの host の中",
    saas: "vendor の cloud の中",
    paas: "PaaS の中",
  },
  {
    axis: "サービスが止まったら",
    us: "自分で動かし続けられる",
    saas: "使えなくなる、値上げも",
    paas: "PaaS が止まれば止まる",
  },
  {
    axis: "中身の透明性",
    us: "open source、全部見える",
    saas: "ブラックボックス",
    paas: "PaaS のコードは非公開",
  },
  {
    axis: "引っ越し",
    us: "同じ module で別 cloud へ",
    saas: "原則不可、export しても互換性なし",
    paas: "不可、lock-in",
  },
  {
    axis: "拡張 / 自作",
    us: "OpenTofu module で追加",
    saas: "vendor が出した連携だけ",
    paas: "vendor の SDK の範囲内",
  },
];

export default function Comparison() {
  return (
    <section id="comparison">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">vs. others</span>
        <h2>ほかの選択肢と、何が違うか。</h2>
        <div class="comparison">
          <table>
            <caption class="sr-only">
              Takosumi と 典型的な SaaS / Vendor PaaS の比較
            </caption>
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col">Takosumi</th>
                <th scope="col">典型的な SaaS</th>
                <th scope="col">Vendor PaaS</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr>
                  <th scope="row">
                    <strong>{r.axis}</strong>
                  </th>
                  <td class="us">{r.us}</td>
                  <td>{r.saas}</td>
                  <td>{r.paas}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
