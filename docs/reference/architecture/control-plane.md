# コントロールプレーンアーキテクチャ {#control-plane-architecture}

→ [Installer API](../installer-api.md) / [Kernel](./kernel.md)

## Read Projection And Reference Internal Surface {#internal-surfaces}

Operator automation reads Installation / Deployment history through the
operator read projection. The route names and auth scheme are operator-owned.
The reference kernel can expose internal HMAC routes such as:

```text
GET /api/internal/v1/installations
GET /api/internal/v1/installations/{id}
GET /api/internal/v1/installations/{id}/deployments
GET /api/internal/v1/installations/{id}/events
```

## 関連ページ

- [Reference Kernel Route Inventory](../kernel-http-api.md)
