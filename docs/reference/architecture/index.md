# 内部設計の概要 {#architecture-overview}

この section は Takosumi kernel の internal architecture notes です。public
contract は [AppSpec](../app-spec.md) と [Installer API](../installer-api.md) を
参照してください。

Takosumi kernel は AppSpec intent を Space context で解決し、snapshot と WAL を
使って provider operation を進めます。

```text
AppSpec + Space context
  -> ResolutionSnapshot
  -> DesiredSnapshot
  -> OperationPlan
  -> WriteAheadOperationJournal
  -> provider / runtime-agent operation
  -> ObservationSet / DriftIndex / RevokeDebt
  -> ActivationSnapshot / GroupHead
```

## Public AppSpec vocabulary {#public-appspec-vocabulary}

AppSpec root は次の 3 field だけです。

```text
apiVersion
metadata
components
```

component の公開 field は `kind`、`spec`、`publish`、`listen` です。
entrypoint、image、route、custom domain などの詳細は kind の `spec` または
operator-provided descriptor / implementation convention
に置きます。kernel-owned release bundle や provider target list はありません。

## 読む順序 {#reading-order}

| Doc                                                                               | Question                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [Kernel](./kernel.md)                                                             | kernel と operator / application の責務境界はどこか。  |
| [Deploy System](./deploy-system.md)                                               | Installation / Deployment lifecycle はどう進むか。     |
| [Runtime Deployment](./runtime-deployment-model.md)                               | snapshot と WAL は何を保証するか。                     |
| [Space Model](./space-model.md)                                                   | Space scope で何が分離されるか。                       |
| [Kind Resolution Model](./kind-resolution-model.md)                               | kind alias / provider / connector 解決はどう決まるか。 |
| [Namespace Export Model](./namespace-export-model.md)                             | component outputs と namespace path はどう扱われるか。 |
| [Link / Projection Model](./link-projection-model.md)                             | publish/listen は runtime binding にどう変換されるか。 |
| [Implementation / Runtime-Agent Boundary](./implementation-operation-envelope.md) | kernel と runtime-agent の境界はどこか。               |
| [External Descriptor Intake](./external-descriptor-registry-model.md)             | descriptor を operator がどう取り込むか。              |
| [Operator Boundaries](./operator-boundaries.md)                                   | operator が選ぶものと kernel が固定するものは何か。    |
| [Workflow Placement](./workflow-extension-design.md)                              | workflow / scheduler をどこに置くか。                  |

## Docs boundary {#docs-boundary}

account、billing、OIDC issuer、customer onboarding、managed offering support
workflow は operator account-plane の architecture として扱います。reference
implementation は `takosumi-cloud/` 側の docs に分かれます。
