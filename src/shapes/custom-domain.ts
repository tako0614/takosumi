import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonEmptyString,
  isRecord,
  optionalNonEmptyString,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";

export type CustomDomainCapability =
  | "wildcard"
  | "auto-tls"
  | "sni"
  | "http3"
  | "alpn-acme"
  | "redirects";

export type CustomDomainCertificateKind = "auto" | "managed" | "provided";

export interface CustomDomainCertificate {
  readonly kind: CustomDomainCertificateKind;
  readonly secretRef?: string;
}

export interface CustomDomainRedirect {
  readonly from: string;
  readonly to: string;
  readonly code?: 301 | 302 | 307 | 308;
}

export interface CustomDomainSpec {
  readonly name: string;
  readonly target: string;
  readonly certificate?: CustomDomainCertificate;
  readonly redirects?: readonly CustomDomainRedirect[];
}

export interface CustomDomainOutputs {
  readonly fqdn: string;
  readonly certificateArn?: string;
  readonly nameservers?: readonly string[];
}

const CAPABILITIES: readonly CustomDomainCapability[] = [
  "wildcard",
  "auto-tls",
  "sni",
  "http3",
  "alpn-acme",
  "redirects",
];

const OUTPUT_FIELDS: readonly string[] = [
  "fqdn",
  "certificateArn",
  "nameservers",
];

const REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 307, 308]);

export const CustomDomainShape: Shape<
  CustomDomainSpec,
  CustomDomainOutputs,
  CustomDomainCapability
> = {
  id: "custom-domain",
  version: "v1",
  description: "DNS + TLS-terminated public domain pointing at a target URL.",
  capabilities: CAPABILITIES,
  outputFields: OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.name, "$.name", issues);
    requireNonEmptyString(value.target, "$.target", issues);
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
    optionalNonEmptyString(value.certificateArn, "$.certificateArn", issues);
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
