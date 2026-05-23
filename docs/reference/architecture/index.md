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

component の公開 field は `kind`、`spec`、`publish`、`listen` です。 provider
id、route、artifact、custom domain などの詳細は kind の `spec` または
materializer convention に置きます。

## 読む順序 {#reading-order}

| Doc                                                                               | Question                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [Kernel](./kernel.md)                                                             | kernel が持つ責務と持たない責務は何か。                |
| [Deploy System](./deploy-system.md)                                               | Installation / Deployment lifecycle はどう進むか。     |
| [Runtime Deployment](./runtime-deployment-model.md)                               | snapshot と WAL は何を保証するか。                     |
| [Space Model](./space-model.md)                                                   | Space scope で何が分離されるか。                       |
| [Namespace Export Model](./namespace-export-model.md)                             | component outputs と namespace path はどう扱われるか。 |
| [Link / Projection Model](./link-projection-model.md)                             | publish/listen は runtime binding にどう変換されるか。 |
| [Implementation / Runtime-Agent Boundary](./implementation-operation-envelope.md) | kernel と runtime-agent の境界はどこか。               |
| [Operator Boundaries](./operator-boundaries.md)                                   | operator が選ぶものと kernel が固定するものは何か。    |
| [Workflow Placement](./workflow-extension-design.md)                              | workflow / scheduler を kernel に入れない理由は何か。  |

## Docs boundary {#docs-boundary}

account、billing、OIDC issuer、customer onboarding、managed offering support
workflow は kernel architecture ではありません。reference implementation は
`takosumi-cloud/` 側の docs に分かれます。
