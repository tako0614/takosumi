# @takos/takosumi

Umbrella package for the Takosumi contract, installer, kernel, CLI,
runtime-agent, and portable official kind descriptors.

Core exports:

- `@takos/takosumi/contract`
- `@takos/takosumi/installer`
- `@takos/takosumi/kernel`
- `@takos/takosumi/runtime-agent`
- `@takos/takosumi/cli`
- `@takos/takosumi/kinds`

Portable kind descriptor packages remain individually installable as
`@takos/takosumi-kind-<alias>`. Backend-specific native plugins live in the
separate `takosumi-plugins` repository and should be imported directly by the
operator distribution that enables them.

```ts
import { descriptor, KIND_URI } from "@takos/takosumi-kind-worker";

console.log(KIND_URI, descriptor);
```
