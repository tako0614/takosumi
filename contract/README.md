# Takosumi Contract

`@takosjp/takosumi-contract` is the curated, versioned TypeScript wire
contract for independent applications that connect to Takosumi. It is not the
Takosumi source-tree contract facade, an SDK for operating the control plane,
or a reference implementation.

Takos and Takosumi build and release independently. An application may depend
on this package, but must not require a Takosumi source checkout, private
Accounts package, service implementation, provider adapter, or matching
Takosumi release commit.

## Entry points

| Import | Public contract |
| --- | --- |
| `@takosjp/takosumi-contract` | The unchanged 2.0 portable runtime entrypoint from `runtime.ts`. Version 2.1 adds no new root exports. |
| `@takosjp/takosumi-contract/background-events` | Portable background-event ABI. |
| `@takosjp/takosumi-contract/managed-runtime-connections` | Portable managed-runtime connection contract. |
| `@takosjp/takosumi-contract/managed-relational-runtime` | Portable managed relational-runtime contract. |
| `@takosjp/takosumi-contract/discovery` | Public API, well-known, and capability paths plus discovery DTOs and builders. |
| `@takosjp/takosumi-contract/interface-types` | Dependency-free Interface protocol type, version, and permission tokens. |
| `@takosjp/takosumi-contract/runtime-interfaces` | App-facing `Interface` and `InterfaceBinding` wire views, constituent types, and lexical validators. |
| `@takosjp/takosumi-contract/notification-pushers` | Generic notification pusher registration and gateway wire contract. |
| `@takosjp/takosumi-contract/identity-oidc` | Standard same-origin Takosumi Accounts OIDC paths for installed clients. |

The package uses an exact export map. There is no wildcard subpath.

The package is distributed under the MIT License independently from the
AGPL-3.0-only Takosumi service implementation.

## Example

```ts
import {
  TAKOSUMI_API_VERSION,
  createTakosumiWellKnownDocument,
} from "@takosjp/takosumi-contract/discovery";
import {
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_OPEN_PERMISSION,
} from "@takosjp/takosumi-contract/interface-types";
import type {
  Interface,
  InterfaceBinding,
} from "@takosjp/takosumi-contract/runtime-interfaces";
import { TAKOSUMI_ACCOUNTS_USERINFO_PATH } from "@takosjp/takosumi-contract/identity-oidc";

const discovery = createTakosumiWellKnownDocument({
  origin: "https://operator-selected.example",
});

console.log(
  discovery.api_versions[0] === TAKOSUMI_API_VERSION,
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_OPEN_PERMISSION,
  TAKOSUMI_ACCOUNTS_USERINFO_PATH,
);

declare const runtimeInterface: Interface;
declare const binding: InterfaceBinding;
void [runtimeInterface, binding];
```

## Boundary

Discovery reports public paths and capabilities that an operator actually
provides. It does not select application infrastructure or grant install,
provider, resource, Run, Apply, Destroy, or lifecycle authority. A repository
manifest may request a generic Takosumi-provided capability and name its module
variable delivery targets, but the application's OpenTofu module remains the
authority for its provider and resource graph.

Repositories remain plain OpenTofu modules. Source identity comes from the
configured Git URL, ref, module path, and resolved commit. A repository may
publish the optional `.well-known/takosumi.json` manifest using the closed
`kind: Repository` envelope. The parser currently accepts exactly
`takosumi.com/v1`, `takosumi.com/v2`, `takosumi.com/v2.1`,
`takosumi.com/v2.2`, `takosumi.com/v2.3`, and `takosumi.com/v2.4`. The v1 and v2
lanes are parser-only; checked-in structural schemas are published for v2.1
through v2.4. Version 2.3 adds only the optional credential-free `sourceBuild`
proposal per module, and v2.4 adds binding-delivered OIDC `ownerSubject`.
Unknown fields remain closed, and no lane accepts provider, credential, target,
billing, permission, or host-execution authority. Takosumi compiles a validated
same-commit install proposal into a DB-owned `InstallConfig`. See the [current
schema matrix](../docs/reference/schema-matrix.md) for the source of truth and
compatibility rules.

The runtime Interface entrypoint is a consumer view. Host-only input resolution,
materialization markers, reconciliation provenance, projection sinks, Capsule
blueprints, and create/status/token issuance requests stay inside the Takosumi
source contract. Interface display parsing and security policy remain
application-owned and are not exported here.

The OIDC entrypoint publishes paths only. The issuer origin, client
registration, scopes, authorization decisions, credentials, and account
service remain operator- or Accounts-owned.

The package does not export `contract/index.ts`, repository install DTOs,
`InstallConfig`, provider bindings/adapters, Run or state lifecycles,
internal APIs or crypto, IP classification, private Accounts code, root
generation, graph/policy libraries, or reference implementations.
