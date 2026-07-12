/**
 * 3-column audience-aware comparison.
 * SaaS = Notion / Slack / Google Docs 等、Vendor PaaS = Heroku / Render 等。
 */
import Section from "./Section";

const ROWS = [
  {
    axis: "データの所在",
    us: "あなたのサーバーの中",
    saas: "ベンダーのクラウドの中",
    paas: "PaaS の中",
  },
  {
    axis: "サービスが止まったら",
    us: "自分で動かし続けられる",
    saas: "使えなくなる・値上げも",
    paas: "PaaS が止まれば止まる",
  },
  {
    axis: "中身の透明性",
    us: "オープンソース、全部見える",
    saas: "ブラックボックス",
    paas: "PaaS のコードは非公開",
  },
  {
    axis: "引っ越し",
    us: "同じコードで別のクラウドへ",
    saas: "原則不可、エクスポートしても互換性なし",
    paas: "不可、ロックイン",
  },
  {
    axis: "拡張 / 自作",
    us: "テンプレートや Git リポジトリで追加",
    saas: "ベンダーが出した連携だけ",
    paas: "ベンダーの SDK の範囲内",
  },
];

export default function Comparison() {
  return (
    <Section
      id="compare"
      title="ほかの選択肢と、何が違うか。"
      lede={
        <>
          便利な SaaS や PaaS と、自分で持つ Takosumi を、
          <em class="em">データが誰のものか</em>という視点で比べています。
        </>
      }
    >
      <div class="comparison">
        <table>
          <caption class="sr-only">
            Takosumi と 典型的な SaaS / ベンダー PaaS の比較
          </caption>
          <thead>
            <tr>
              <th scope="col"></th>
              <th scope="col">Takosumi</th>
              <th scope="col">典型的な SaaS</th>
              <th scope="col">ベンダー PaaS</th>
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
    </Section>
  );
}
