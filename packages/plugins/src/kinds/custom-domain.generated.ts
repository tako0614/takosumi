// AUTO-GENERATED FROM spec/contexts/kinds/v1/custom-domain.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface CustomDomainCertificate {
  readonly kind: "auto" | "managed" | "provided";
  readonly secretRef?: string;
}

export interface CustomDomainRedirect {
  readonly from: string;
  readonly to: string;
  readonly code?: 301 | 302 | 307 | 308;
}

export interface CustomDomainSpec {
  /** Fully-qualified domain name (e.g. `notes.example.com`). */
  readonly name: string;
  /** TLS certificate provisioning policy. `secretRef` is required when `kind: provided`. */
  readonly certificate?: CustomDomainCertificate;
  /** HTTP redirect rules served by the domain edge. */
  readonly redirects?: readonly CustomDomainRedirect[];
}

export interface CustomDomainOutputs {
  /** Resolved fully-qualified domain name. */
  readonly fqdn: string;
  /** Provider-scope TLS certificate identifier. */
  readonly certificateId?: string;
  /** DNS nameserver list (when delegated). */
  readonly nameservers?: readonly string[];
}

export type CustomDomainCapability =
  | "wildcard"
  | "auto-tls"
  | "sni"
  | "http3"
  | "alpn-acme"
  | "redirects";

export type CustomDomainPublishesTo = "<app-id>.<component-name>";

export type CustomDomainListensFrom = "<sibling-worker-namespace>";

export const CUSTOM_DOMAIN_CAPABILITIES: readonly CustomDomainCapability[] = [
  "wildcard",
  "auto-tls",
  "sni",
  "http3",
  "alpn-acme",
  "redirects",
];

export const CUSTOM_DOMAIN_OUTPUT_FIELDS: readonly string[] = [
  "fqdn",
  "certificateId",
  "nameservers",
];

export const CUSTOM_DOMAIN_ALIASES: readonly string[] = [
  "custom-domain",
];

export const CUSTOM_DOMAIN_PUBLISHES_TO: readonly CustomDomainPublishesTo[] = [
  "<app-id>.<component-name>",
];

export const CUSTOM_DOMAIN_LISTENS_FROM: readonly CustomDomainListensFrom[] = [
  "<sibling-worker-namespace>",
];

export const CUSTOM_DOMAIN_KIND_ID = "custom-domain";
export const CUSTOM_DOMAIN_KIND_VERSION = "v1";
export const CUSTOM_DOMAIN_DESCRIPTION =
  "DNS + TLS-terminated public domain pointing at a target URL. Listens on a sibling worker namespace to obtain its allocated URL, then publishes its FQDN to the sibling namespace path.";
