# Account Management Ownership Ledger {#account-plane-ownership-ledger}

The ownership ledger is Takosumi's account management projection around Takosumi Installation (a record of an installed app) and Deployment (a record of a deployed version) records. It answers account-facing questions that OAuth alone cannot answer: who installed this app, who pays for it, who can revoke it, and what can be exported.

## Ownership Chain

```text
TakosumiAccount
  -> Space
  -> CloudInstallationProjection
      -> BindingMaterialRecord[]
      -> CloudCapabilityGrant[]
      -> InstallationEvent[]
```

Takosumi remains the authority for source guard, install/deploy lifecycle, Deployment apply/rollback, and current Deployment pointer. Cloud manages account, Space, billing owner, launch token, capability, PlatformService inventory, and projection state.

## Projection Status

Cloud status values are:

```text
installing | ready | failed | suspended | exported
```

In-flight work such as deploying, rolling back, materializing, exporting, or importing is represented by operation metadata and events, not extra public status values.

## Runtime Mode

```text
shared-cell | dedicated | self-hosted
```

Runtime mode is Cloud projection state. It is not a manifest field and not a Takosumi Installer API status.

## Capability Grants

Cloud capability grants are account management ledger state derived from account policy, adopted kind definitions, workload platform service resolution, and product profile policy. They are not manifest fields and do not have a public grant-management route in the base profile.

Examples managed by the Cloud base profile:

```text
deploy.intent.write
logs.read.own
billing.usage.report
```

Product profiles manage their own capability vocabulary.
