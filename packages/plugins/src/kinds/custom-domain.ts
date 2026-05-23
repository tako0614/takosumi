import type { Shape } from "takosumi-contract";
import {
  isNonEmptyString,
  optionalNonEmptyString,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
import {
  CUSTOM_DOMAIN_CAPABILITIES,
  CUSTOM_DOMAIN_DESCRIPTION,
  CUSTOM_DOMAIN_KIND_ID,
  CUSTOM_DOMAIN_KIND_VERSION,
  CUSTOM_DOMAIN_OUTPUT_FIELDS,
  type CustomDomainCapability,
  type CustomDomainOutputs,
  type CustomDomainSpec,
} from "./custom-domain.generated.ts";

export type { CustomDomainCapability, CustomDomainOutputs, CustomDomainSpec };

/**
 * `custom-domain@v1` component kind descriptor. Materialized by a provider
 * plugin (Cloudflare / managed DNS+TLS / etc.) at apply time.
 *
 * Spec / outputs / capabilities are derived from
 * `packages/plugins/spec/kinds/v1/custom-domain.jsonld` via
 * `custom-domain.generated.ts`; validation diagnostics are hand-written
 * below.
 */
export const CustomDomainKind: Shape<
  CustomDomainSpec,
  CustomDomainOutputs,
  CustomDomainCapability
> = {
  id: CUSTOM_DOMAIN_KIND_ID,
  version: CUSTOM_DOMAIN_KIND_VERSION,
  description: CUSTOM_DOMAIN_DESCRIPTION,
  capabilities: CUSTOM_DOMAIN_CAPABILITIES,
  outputFields: CUSTOM_DOMAIN_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.name, "$.name", issues);
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.fqdn, "$.fqdn", issues);
    optionalNonEmptyString(value.certificateId, "$.certificateId", issues);
    if (value.nameservers !== undefined) {
      if (!Array.isArray(value.nameservers)) {
        issues.push({ path: "$.nameservers", message: "must be an array" });
      } else if (!value.nameservers.every(isNonEmptyString)) {
        issues.push({
          path: "$.nameservers",
          message: "must contain only non-empty strings",
        });
      }
    }
  },
};
