# Takosumi Hosted pricing

Takosumi Hosted と Takoserver のローンチ料金は税別 USD です。Free と月額プランの
利用枠を、同じ Organization の残高から両製品で利用する方針です。

> **提供状態:** 以下は採用済みのローンチ料金です。共通ログイン、Workspace、課金の
> 切り替えと staging 検証は進行中です。このページだけで利用可能とは判断せず、
> 認証済みの料金表示と提供状態を確認してください。Container の価格 revision も
> 有効化前であり、既存の利用に新単価を遡って適用しません。

## Plans and top-ups

| プラン | 月額料金 | 毎月の利用枠 | カード |
| --- | ---: | ---: | --- |
| Free | `$0` | `$1.50` | 不要 |
| `$10` plan | `$10` | `$20` | 必要 |
| `$50` plan | `$50` | `$100` | 必要 |

利用枠は毎月リセットします。有料プランに Free の `$1.50` を加算しません。
top-up は支払額と同額の残高を追加し、プランの利用枠を倍増する倍率は適用しません。
有料プラン、top-up、on-demand の利用時に支払い方法を登録します。

## Account, Workspace and balance

ローンチでは `auth.takos.jp` の共通アカウントで両製品へログインし、最初のログインで
personal Workspace を用意します。チーム、請求、環境を分ける追加 Workspace も
共通の Workspace と membership を使います。メールアドレスの一致だけで、他の
Workspace の権限を得ることはありません。

各 Workspace に紐づく Organization が支払い先を決めます。同じ Organization の
Takosumi Hosted と Takoserver は一つの wallet を使い、製品ごとの二重残高を持ちません。
利用量には発生元の Workspace と Resource を記録し、Workspace 別の内訳を表示します。
Workspace を切り替えても、同じ Organization に属する残高や利用枠は増えません。

## Usage prices

Cloudflare-backed の利用料金は、Takoserver が供給する versioned price revision の
Cloudflare 従量単価の **3 倍**です。公開原価が変わっても、ブラウザがその場で料金を
再計算することはありません。適用する revision、meter、単位、単価は認証済みの
料金表示で確認してください。新しい revision は有効化後の利用に適用します。

供給側の料金定義は
[Takoserver shared hosted pricing](https://github.com/tako0614/takoserver/blob/main/config/shared-hosted-pricing.json)
が所有します。Takosumi Hosted はこの料金とプランの snapshot を表示し、別の価格表や
商用 ledger を作りません。供給側の free tier は、上記の Free 利用枠とは別です。
価格のない meter や未提供のサービスを、このページから有効とは扱いません。

### Container launch rates

Container は実行経路が変わっても同じ単価とし、Cloudflare Containers の原価を基準に
します。以下は採用済みの追加 meter で、価格 revision の公開と有効化を待っています。

| Meter | 課金単位 | ローンチ単価 |
| --- | --- | ---: |
| CPU | vCPU-second | `$0.000060` |
| Memory | GiB-second | `$0.0000075` |
| Egress | GB | `$0.15` |
| Image storage | GB-month | `$0.045` |

CPU と memory は [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
の従量単価を基準にします。egress は全地域で共通とし、同ページの最も高い地域単価
`$0.05 / GB` を基準にします。image storage は
[R2 Standard storage pricing](https://developers.cloudflare.com/r2/pricing/) の
`$0.015 / GB-month` を基準にします。disk は今回の追加 meter に含めません。
Container を通る Worker などの利用は、対応する有効な meter が別途適用されます。

## Usage display and spending limits

利用枠の消費率を percent で表示し、80% と 95% で警告します。
`onLimit` の初期値は `stop` で、利用枠や残高を超える消費を止めます。
自動的に有料プランへ変更したり、後払いへ切り替えたりしません。

| `onLimit` | 方針 |
| --- | --- |
| `stop` | 初期値。上限に達したら対象の消費を停止 |
| `prepaid` | 明示的に選択した場合だけ、購入済みの残高を利用 |
| `postpaid` | 対応・適格性を確認してから明示的に選択する後払い |
| `on-demand` | 支払い方法と条件を確認してから明示的に選択する従量利用 |

選択肢は認証済みの契約で有効なものだけを表示します。供給側の現行料金定義では
`postpaid` は未対応であり、今すぐ選択できる機能ではありません。上限到達を理由に
既存 Resource を自動削除せず、削除は作成に使った provider graph から行います。

## Preview and invoice contract

実行前の Preview で、適用する価格 revision、meter、単価、税区分、見積り、有効期限を
確認します。Apply は確認した exact quote を使います。料金がない meter、未発効の
catalog、未設定の billing manager、期限切れの quote は backend 実行前に停止します。
利用量、reservation、返金・credit、請求書の明細は、請求期間の確定前に照合します。

## Amount precision and tax

共通 ledger は整数の micro-USD（`$1 = 1,000,000 micro-USD`）で金額を保持します。
たとえば Container memory は `1,000 GiB-second` あたり `7,500 micro-USD` です。
小数の利用 event ごとに cent へ切り上げず、集計した請求額を支払い時に一度だけ
cent へ切り上げます。税額と支払い総額は Checkout と請求書で確認してください。

## App addresses

ローンチの Hosted アプリは `<name>.app.takos.jp` を使う方針です。名前は両製品で
共通の一意な名前として予約し、Takoserver が一つの dispatch と wildcard TLS を
所有します。現在は staging で検証中であり、本番の route 切り替えは未実施です。
Hosted の custom domain はローンチ後の対象です。セルフホストで使う
CustomDomain の選択肢は維持します。

## Bring your own provider

自分の Provider Connection で利用する外部 provider は、その provider の契約で
直接請求されます。上記の Hosted 利用枠や 3 倍ルールを外部 provider の請求へ
重ねて適用しません。セルフホストの Takosumi ソフトウェアに利用料はありません。
実行環境と外部 provider の費用は、それぞれの供給元へ支払います。
