/**
 * 3 列 audience-aware comparison (Wave M-H3 訂正後)。
 * SaaS = Notion / Slack / Google Docs 等 (= 非技術者にも届く対比軸)、
 * Vendor PaaS = Heroku / Render 等。 旧「素の cloud」「Terraform」 列は
 * 削除 (= 非技術者には伝わらない + WhyOperatorOwned で本質は語り済)。
 */
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
    saas: "使えなくなる、 値上げも",
    paas: "PaaS が止まれば止まる",
  },
  {
    axis: "中身の透明性",
    us: "open source、 全部見える",
    saas: "ブラックボックス",
    paas: "PaaS のコードは非公開",
  },
  {
    axis: "引っ越し",
    us: "manifest 1 行で別 cloud へ",
    saas: "原則 不可、 export しても 互換性なし",
    paas: "不可、 lock-in",
  },
  {
    axis: "拡張 / 自作",
    us: "JSON-LD で 新 kind を 追加",
    saas: "vendor が出した連携だけ",
    paas: "vendor の SDK の範囲内",
  },
];

export default function Comparison() {
  return (
    <section id="comparison">
      <div class="container">
        <span class="eyebrow">vs. others</span>
        <h2>ほかの選択肢と、 何が違うか。</h2>
        <div class="comparison">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Takosumi</th>
                <th>典型的な SaaS</th>
                <th>Vendor PaaS</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr>
                  <td>
                    <strong>{r.axis}</strong>
                  </td>
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
