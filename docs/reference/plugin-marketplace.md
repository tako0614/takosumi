# Plugin Marketplace and Remote Install

> Stability: beta Audience: operator / plugin publisher See also:
> [Catalog Release Trust](/reference/catalog-release-trust),
> [WAL Stages](/reference/wal-stages), [Provider Plugins](/reference/providers)

Takosumi plugin marketplace install is an **operator-only** supply-chain path.
User manifests never install code. A marketplace publishes a signed package
index; the kernel fetches the selected package module, verifies its SHA-256
digest, verifies the signed kernel plugin manifest against operator-trusted
publisher keys, then enables the package.

## Package kinds

Two package kinds are supported.

| Kind                      | Runtime effect                                                               |
| ------------------------- | ---------------------------------------------------------------------------- |
| `kernel-plugin`           | Installs a `TakosumiKernelPlugin` implementation for a kernel plugin port.   |
| `executable-hook-package` | Installs a CatalogRelease WAL hook package for `pre-commit` / `post-commit`. |

Executable hook packages expose:

```ts
export const catalogHookPackage = {
  id: "takos.hook.risk-gate",
  version: "1.0.0",
  stages: ["pre-commit", "post-commit"],
  async run(input) {
    return { ok: true };
  },
};
```

The hook input contains the Space id, stage, OperationPlan digest,
DesiredSnapshot digest, per-operation idempotency keys, and the verified
CatalogRelease identity when one is adopted for the Space.

## Marketplace index

```json
{
  "schemaVersion": "takosumi.plugin-marketplace.v1",
  "marketplaceId": "market:example",
  "generatedAt": "2026-05-05T00:00:00.000Z",
  "packages": [
    {
      "packageRef": "takos.hook.risk-gate",
      "kind": "executable-hook-package",
      "version": "1.0.0",
      "manifestEnvelope": {
        "manifest": {
          "id": "takos.hook.risk-gate",
          "name": "Risk Gate",
          "version": "1.0.0",
          "kernelApiVersion": "2026-04-29",
          "capabilities": [
            {
              "port": "catalog-hook",
              "kind": "catalog-release-wal-hook",
              "externalIo": ["network"]
            }
          ],
          "metadata": {
            "implementationProvenance": {
              "moduleSpecifier": "https://market.example/risk-gate.js",
              "moduleDigest": "sha256:..."
            }
          }
        },
        "signature": {
          "alg": "ECDSA-P256-SHA256",
          "keyId": "publisher-key:example",
          "value": "base64url-signature"
        }
      },
      "module": {
        "specifier": "https://market.example/risk-gate.js",
        "digest": "sha256:..."
      }
    }
  ]
}
```

`packageRef` must match the signed manifest id. The module digest is verified
before import. In production policy, set `requireImplementationProvenance` and
`requireRemoteModuleDigest` so the signed manifest binds the same
`moduleSpecifier` and `moduleDigest` as the marketplace index.

## Kernel boot env

Remote marketplace install is configured at kernel boot:

| Variable                                      | Format                           |
| --------------------------------------------- | -------------------------------- |
| `TAKOSUMI_KERNEL_PLUGIN_MARKETPLACE_URLS`     | comma-separated marketplace URLs |
| `TAKOSUMI_KERNEL_PLUGIN_MARKETPLACE_PACKAGES` | comma-separated package refs     |
| `TAKOSUMI_KERNEL_PLUGIN_TRUST_KEYS`           | JSON array of publisher keys     |
| `TAKOSUMI_KERNEL_PLUGIN_INSTALL_POLICY`       | JSON install policy object       |

The install policy supports the trusted-install fields plus marketplace module
guards:

```json
{
  "enabledPluginIds": ["takos.hook.risk-gate"],
  "trustedKeyIds": ["publisher-key:example"],
  "allowedPublisherIds": ["publisher:example"],
  "allowedPorts": ["catalog-hook"],
  "allowedExternalIo": ["network"],
  "allowedModuleSpecifierPrefixes": ["https://market.example/"],
  "requireImplementationProvenance": true,
  "requireRemoteModuleDigest": true
}
```

## CLI

```bash
takosumi plugin marketplace fetch --url https://market.example/index.json
takosumi plugin install \
  --marketplace https://market.example/index.json \
  --package takos.hook.risk-gate \
  --trust-keys ./publisher-keys.json \
  --policy ./install-policy.json
```

`plugin install` performs the same fetch, module digest verification, signed
manifest verification, and install-policy checks locally. It is intended for
operator CI and release promotion before the same marketplace URL/package list
is placed in the kernel boot environment.

## WAL behavior

Executable hook packages run after CatalogRelease re-verification at the
matching WAL stage.

- `pre-commit` hook failure fails closed before provider side effects and
  appends terminal `abort`.
- `post-commit` hook failure is journaled, enqueues `approval-invalidated`
  RevokeDebt for committed operations, and records observe/finalize evidence.
- Hook packages must be idempotent for repeated calls with the same
  OperationPlan digest and journal entry ids.
