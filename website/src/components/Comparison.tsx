/**
 * 3 軸だけの軽い比較表。 「他と何が違うか」 を秒で伝える用途。
 * vendor PaaS = Heroku/Render 等、 raw cloud = AWS console を直接、
 * Terraform = TF + Helm + 自前 wrapper の組み合わせ。
 */
const ROWS = [
  {
    axis: "移植",
    us: "manifest 1 行で別 cloud へ",
    vendor: "不可、 lock-in",
    cloud: "自分で書き直す",
    tf: "provider 毎に別 module",
  },
  {
    axis: "self-host",
    us: "deno install で OK",
    vendor: "不可",
    cloud: "—",
    tf: "TF state backend を別途",
  },
  {
    axis: "credential",
    us: "自分の VM の中だけ",
    vendor: "vendor 側に預ける",
    cloud: "ローカル設定散在",
    tf: "TF state に残ることも",
  },
];

export default function Comparison() {
  return (
    <section id="comparison">
      <div class="container">
        <span class="eyebrow">vs. others</span>
        <h2>他と何が違うか。</h2>
        <div class="comparison">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Takosumi</th>
                <th>Vendor PaaS</th>
                <th>素の cloud</th>
                <th>Terraform</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr>
                  <td>
                    <strong>{r.axis}</strong>
                  </td>
                  <td class="us">{r.us}</td>
                  <td>{r.vendor}</td>
                  <td>{r.cloud}</td>
                  <td>{r.tf}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
