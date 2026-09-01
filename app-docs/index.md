# Takosumi Cloud

> **歴史資料（アーカイブ）— 現行の正本ではありません。** このページは退役した
> Takosumi Cloud の計画・実装を記録したものです。現行の availability、pricing、SLA、
> support、production authority を示しません。Takosumi Hosted が新しい
> retail/commerce/client composition docs を所有し、managed supply、capacity、provider
> credential、Offering は Takoserver が所有します。本文は歴史的証拠として保持しており、
> 現行サービスの根拠に使わないでください。

Takosumi Cloud は、Git repository の OpenTofu module を実行し、必要なクラウドサービスと
接続できる hosted Takosumi です。plan、apply、state、output、監査、利用量、クレジットを
一つの Workspace で確認できます。

> **Status:** Pre-GA。コードや catalog entry が存在しても、利用可能とは限りません。
> Dashboard と認証済み Cloud catalog に表示される `available` が現在の提供状態です。

## 最初のデプロイ

1. [Dashboard](https://app.takosumi.com/) にサインインし、Workspace を選びます。
2. Store または Git URL から repository を追加します。
3. module が必要とする provider connection を選びます。
4. plan と見積りを確認し、apply します。
5. Run の Output と、アプリが公開した Interface から接続先を開きます。

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

## Takosumi Cloud の役割

Takosumi Cloud は次を提供します。

- hosted dashboard、Accounts、runner、state、Output、audit
- provider connection と credential の runner-only materialization
- prepaid credit、利用量、quota、spend guard
- 利用可能な hosted service と標準 protocol endpoint
- deployed service へ安全に接続する Interface / InterfaceBinding

Cloud 独自の提供可否、価格、容量、請求、support は Takoform の Form maturity とは別です。
provider や schema が公開されただけでは Cloud service は有効になりません。

## Takoform

Takosumi Cloud は official Takoform Host になる予定ですが、現在の candidate Host は未公開・
未接続です。公開前の FormRef、schema digest、Host route は production capability として
広告しません。

公開後も Takoform は hidden runner mode にはなりません。Cloud の既定接続は通常の
ProviderConnection / ProviderBinding を使い、利用者は自分の互換 Host 接続へ差し替えられます。

## Data endpoints

既存サービスのデータを扱うため、Takosumi Cloud は S3-compatible object access と
OpenAI-compatible AI access を提供できます。これらは作成 API ではありません。service の
lifecycle は repository の provider graph が管理し、endpoint と権限は Output / Interface
から取得します。

- [Resources and providers](./resources.md)
- [Data endpoints](./endpoints.md)
- [Pricing](./pricing.md)
- [Support](./support.md)
- [SLA](./sla.md)
- [Takosumi software docs](https://takosumi.com/docs/)
