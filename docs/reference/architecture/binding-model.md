# Binding Model {#link-and-projection-model}

Takosumi v1 の public Source は binding graph DSL を持ちません。install / deploy
request、operator policy、account-plane UI が `BindingSelection` を与え、
operator distribution が PlatformService inventory で解決します。Takosumi
は解決結果を Deployment の `bindingsSnapshot` に保存します。

## Binding Snapshot {#binding-snapshot}

`bindingsSnapshot` は apply 時点で workload がどの PlatformService を使うかを
説明する immutable evidence です。典型的には次の情報を含みます。

```yaml
ResolvedBinding:
  binding: DATABASE
  platformServiceId: service_database_primary
  platformServicePath: database.primary.connection
  access: read-write
  projection:
    family: secret-env
    target: DATABASE_URL
  evidenceDigest: sha256:...
```

この形式は reference implementation の説明用です。public Installer API の安定
surface は Source / Installation / Deployment / PlatformService / InstallPlan です。

## Space Rule {#space-rule}

binding resolution は常に Space の中で行われます。別 Space の同じ service path は
別 subject です。cross-Space sharing は future RFC scope であり、current v1 の
public Source surface にはありません。

## Projection Families {#projection-families}

Projection family は operator distribution と adapter が定義します。例:

```text
env
secret-env
upstream
config-mount
```

secret-bearing data を plain env や public URL へ落とす unsafe projection は
fail-closed で拒否します。どの projection が利用できるかは PlatformService
definition、operator policy、adapter capability で決まります。

## Mutation Classes {#mutation-classes}

Reference implementation は binding の変化を次の mutation class として記録できます。

```text
rematerialize
reproject
reauthorize
rewire
revoke
retain-generated
no-op
repair
```

これらは Deployment evidence と operator recovery のための内部分類です。Takosumi
v1 の Source authoring vocabulary ではありません。

## Collision Rules {#collision-rules}

Projection が runtime target の既存 input と衝突する場合、operator resolver は
決定的な precedence を持つか fail-closed しなければなりません。public v1 には
source-level override 機構はありません。operator 側の override を導入する場合は
distribution-local policy または future RFC として扱います。
