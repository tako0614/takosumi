# Takosumi Cloud {#takosumi-cloud-distribution}

Takosumi Cloud は別の operator distribution 仕様です。このページは、Takosumi core と公式型カタログを読んだあとに Cloud-owned account layer behavior を確認したい読者の入口です。

## 仕様の持ち主

| Surface                                                              | Owner                                            |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| AppSpec / Installation / Deployment / Installer API                  | [Takosumi core 仕様](./core-spec.md)             |
| kind schema vocabulary / 出力の型 / injection modes                  | [Takosumi 公式型カタログ仕様](./type-catalog.md) |
| Accounts / OIDC / billing / dashboard / launch token / deploy facade | Takosumi Cloud distribution specification        |

Takosumi Cloud は Takosumi core Installer API と Cloud account layer record / API を組み合わせます。Cloud は公式型カタログの output type を採用できます。具体的な platform service path、identity behavior、billing integration、dashboard surface、launch token flow、account-facing Installation projection、 export/materialize action、deploy facade は Cloud docs に置きます。

Cloud platform service path の例として `identity.primary.oidc` と `billing.primary.account` があります。これらは workload が manifest の `listen.path` から参照できる Cloud の出力データです。出力の型は公式型カタログ、 dotted reference grammar は Takosumi core、concrete path と lifecycle は Cloud distribution spec が定義します。

Cloud は Installer API を authorization / approval / account layer projection と組み合わせる admin facade を持てます。この facade identifier は Cloud distribution spec の surface であり、workload の root `publish` が公開する service path ではなく、Takosumi core concept でもありません。

## Cloud 仕様を読む

Cloud distribution 仕様の規定本文は Takosumi Cloud docs に置きます。公開パスは `https://cloud.takosumi.com/docs/`、local mirror は `https://cloud.takosumi.test/docs/` です。

- [Takosumi Cloud docs](https://cloud.takosumi.com/docs/)
- [日本語: Takosumi Cloud Distribution Contract v1](https://cloud.takosumi.com/docs/ja/spec)
- [English: Takosumi Cloud Distribution Contract v1](https://cloud.takosumi.com/docs/en/spec)

この checkout での maintainer path は `takosumi-cloud/docs/ja/spec.md` と `takosumi-cloud/docs/en/spec.md` です。root 直下の旧 Cloud docs page は言語別 docs への入口だけを持ちます。

この Takosumi page は bridge として読みます。Cloud-owned account layer compatibility は Cloud spec が正本です。AppSpec、Installation、Deployment、 Installer API は Takosumi core が正本です。

## 関連ページ

- [仕様境界](./spec-boundaries.md)
- [プラットフォームサービス](./platform-services.md)
- [manifest](./manifest.md)
- [Installer API](./installer-api.md)
