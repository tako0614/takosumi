# Takosumi アーキテクチャ {#takosumi-architecture}

Takosumi は Takosumi と account/operator 実装を組み合わせます。

| Component | Responsibility |
| --- | --- |
| Takosumi | Source guard、Installation / Deployment、Installer API |
| Takosumi Accounts | account session、OIDC、billing、projection ledger、launch token、facade |
| Dashboard | Accounts API と projection record の UI |
| Provider/runtime adapters | PlatformService の materialization と provider evidence |

Cloud は auth、policy、billing、approval を確認した上で Installer API を呼び、
account-facing projection と event を記録します。
