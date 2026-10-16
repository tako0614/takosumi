# Takosumi hosted service

Takosumi hosted service は、Git repository の OpenTofu module を実行し、必要なクラウドサービスに
接続する Takosumi のホスティングサービスです。plan、apply、state、output、監査、利用量、クレジットを
一つの Workspace で確認できます。

> **Status:** Pre-GA。コードや catalog entry が存在しても、利用可能とは限りません。
> Dashboard と認証済み Takosumi catalog に表示される `available` が現在の提供状態です。

## 最初のデプロイ

1. [ダッシュボード](https://app.takosumi.com/) にサインインし、ワークスペースを選びます。
2. **ストア** でアプリの **追加** を押すか、**Gitリポジトリから追加** で Git URL を入れます。
   アプリの追加 link を開いた場合も同じ画面になります。
3. サービス名と取得元を確認して **追加** を押します。Takosumi が Git の版を固定し、module と
   必要な接続を調べます。この時点ではまだ何も作られません。
4. 接続を選ぶ必要があれば **ホスト / アカウントを選択** で選びます。認証情報が不要な provider
   には接続は要りません。続く **サービスを設定** でアプリが求める項目を入れ、**続ける** を
   押します。
5. **追加前の確認** で、作成・変更・削除されるリソースの数を確かめてから **追加する** を
   押します。削除・置き換え・import を含む変更は、先に **この変更を承認** を押し、
   **変更内容を確認しました** にチェックしてから進みます。ポリシーや料金の条件で進められない
   変更は **この変更はデプロイできません** と表示されます。
6. **追加できました** と表示されたら、**サービスを開く** から使い始めます。

```text
Git repository
  → OpenTofu plan / review / apply
  → provider control plane
  → state + typed Output
  → authorized Interface
```

Cloudflare、AWS、Takoform などは runner から見ると同じ通常の provider です。各 provider
の control plane が作成した object の lifecycle を所有し、Takosumi は同じ object を別の
resource ledger に複製しません。

## Takosumi hosted service の役割

Takosumi hosted service は次を提供します。

- hosted dashboard、Accounts、runner、state、Output、audit
- provider connection と credential を、実行する runner の中にだけ実体として用意する仕組み
- prepaid credit、利用量、quota、spend guard
- 利用可能な hosted service と標準 protocol endpoint
- deployed service へ安全に接続する Interface / InterfaceBinding

Takosumi hosted service 独自の提供可否、価格、容量、請求、support は Takoform の Form maturity とは別です。
provider や schema が公開されただけでは hosted service は有効になりません。

## Takoform

Takosumi hosted service は official Takoform Host になる予定ですが、現在の candidate Host は未公開・
未接続です。公開前の FormRef、schema digest、Host route は production capability として
広告しません。

公開後も Takoform は hidden runner mode にはなりません。hosted service の既定接続は通常の
ProviderConnection / ProviderBinding を使い、利用者は自分の互換 Host 接続へ差し替えられます。

## Data endpoints

既存サービスのデータを扱うため、Takosumi hosted service は S3-compatible object access と
OpenAI-compatible AI access を提供できます。これらは作成 API ではありません。service の
lifecycle は repository の provider graph が管理し、endpoint と権限は Output / Interface
から取得します。

- [Resources and providers](./resources.md)
- [Data endpoints](./endpoints.md)
- [Pricing](./pricing.md)
- [Support](./support.md)
- [SLA](./sla.md)
- [Takosumi software docs](https://takosumi.com/docs/)
