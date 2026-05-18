import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonEmptyString,
  isRecord,
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
  type CustomDomainCertificate,
  type CustomDomainOutputs,
  type CustomDomainRedirect,
  type CustomDomainSpec,
} from "./custom-domain.generated.ts";

export type {
  CustomDomainCapability,
  CustomDomainCertificate,
  CustomDomainOutputs,
  CustomDomainRedirect,
  CustomDomainSpec,
};

/** Certificate provisioning policy derived from the generated nested type. */
export type CustomDomainCertificateKind = CustomDomainCertificate["kind"];

const REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 307, 308]);

/**
 * `custom-domain@v1` component kind descriptor. Materialized by a provider
 * plugin (Cloudflare / managed DNS+TLS / etc.) at apply time.
 *
 * Spec / outputs / capabilities are derived from
 * `spec/contexts/kinds/v1/custom-domain.jsonld` via
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
    if (value.certificate !== undefined) {
      validateCertificate(value.certificate, issues);
    }
    if (value.redirects !== undefined) {
      validateRedirects(value.redirects, issues);
    }
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

function validateCertificate(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.certificate", message: "must be an object" });
    return;
  }
  if (
    value.kind !== "auto" && value.kind !== "managed" &&
    value.kind !== "provided"
  ) {
    issues.push({
      path: "$.certificate.kind",
      message: "must be 'auto', 'managed', or 'provided'",
    });
  }
  if (value.kind === "provided" && !isNonEmptyString(value.secretRef)) {
    issues.push({
      path: "$.certificate.secretRef",
      message: "must be set when kind is 'provided'",
    });
  }
  optionalNonEmptyString(value.secretRef, "$.certificate.secretRef", issues);
}

function validateRedirects(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push({ path: "$.redirects", message: "must be an array" });
    return;
  }
  for (const [index, entry] of value.entries()) {
    const path = `$.redirects[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }
    requireNonEmptyString(entry.from, `${path}.from`, issues);
    requireNonEmptyString(entry.to, `${path}.to`, issues);
    if (entry.code !== undefined && !REDIRECT_CODES.has(entry.code as number)) {
      issues.push({
        path: `${path}.code`,
        message: "must be 301, 302, 307, or 308",
      });
    }
  }
}
