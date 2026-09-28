import { CAPTURES } from "~/content/captures";

export default function Journey() {
  return (
    <section class="journey" id="how" aria-labelledby="journey-title">
      <div class="container">
        <div class="journey-intro">
          <h2 id="journey-title">選んだあとも、迷わない。</h2>
          <p>たとえば Yurucommu。画面で使いたいアプリを選び、接続と設定を確認してからインストールします。</p>
        </div>
        <div class="journey-layout">
          <div class="journey-steps">
            <div class="journey-step"><span>01</span><div><h3>選ぶ</h3><p>利用画面と必要な環境を見て、Yurucommu を選びます。</p></div></div>
            <div class="journey-step"><span>02</span><div><h3>設定する</h3><p>Git の内容を読み込み、必要な接続、ドメインや入力値を確認します。</p></div></div>
            <div class="journey-step"><span>03</span><div><h3>インストールする</h3><p>必要な設定を確認して実行。追加の確認が必要な変更は、内容を確かめて進めます。</p></div></div>
            <div class="journey-step"><span>04</span><div><h3>開いて使う</h3><p>作成されたアプリを開いて使います。更新や稼働状態も、その後で確認できます。</p></div></div>
          </div>
          <div class="journey-visual">
            <picture>
              <source media="(max-width: 700px)" srcset={CAPTURES.yurucommu.mobile.src} width={CAPTURES.yurucommu.mobile.width} height={CAPTURES.yurucommu.mobile.height} />
              <img src={CAPTURES.yurucommu.desktop.src} width={CAPTURES.yurucommu.desktop.width} height={CAPTURES.yurucommu.desktop.height} alt="Yurucommu のデモ利用画面" loading="lazy" decoding="async" />
            </picture>
            <p>入れた先にあるのは、使いたかったアプリそのもの。</p>
            <a href="https://app.takosumi.com/new">ほかの Git URL から追加する <span aria-hidden="true">↗</span></a>
          </div>
        </div>
      </div>
    </section>
  );
}
