import type {
  FetchLike,
  HostCapabilities,
  HostDiscovery,
  MobileProductKind,
  ProductWellKnown,
  TakosumiWellKnown,
} from "./types.ts";
import { parseMobileProductKind } from "./handoff.ts";
import { hostEndpoint, normalizeHostUrl } from "./url.ts";
import { requireMobileProductKey } from "./product-key.ts";

const takosumiWellKnownPath = "/.well-known/takosumi";
const capabilitiesPath = "/v1/capabilities";

export async function discoverHost(input: {
  readonly hostUrl: string;
  readonly expectedProduct?: MobileProductKind;
  readonly fetch?: FetchLike;
}): Promise<HostDiscovery> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const hostUrl = normalizeHostUrl(input.hostUrl);
  const expectedProduct = input.expectedProduct
    ? requireMobileProductKey(input.expectedProduct, "Expected product")
    : undefined;
  const productPath = expectedProduct
    ? `/.well-known/${expectedProduct}`
    : undefined;

  const [takosumi, capabilities, product] = await Promise.all([
    fetchOptionalJson<TakosumiWellKnown>(
      fetcher,
      hostEndpoint(hostUrl, takosumiWellKnownPath),
    ),
    fetchOptionalJson<HostCapabilities>(
      fetcher,
      hostEndpoint(hostUrl, capabilitiesPath),
    ),
    productPath
      ? fetchOptionalJson<ProductWellKnown>(
          fetcher,
          hostEndpoint(hostUrl, productPath),
        )
      : undefined,
  ]);

  const detectedProduct = detectProduct(takosumi, capabilities, product);
  if (
    expectedProduct &&
    detectedProduct &&
    detectedProduct !== expectedProduct
  ) {
    throw new Error(`Host is ${detectedProduct}, not ${expectedProduct}.`);
  }

  const oidcIssuer =
    product?.issuer ??
    readIdentityIssuer(capabilities) ??
    readTakosumiIssuer(takosumi) ??
    hostUrl;

  return {
    hostUrl,
    expectedProduct,
    detectedProduct,
    takosumi,
    capabilities,
    product,
    oidcIssuer,
    oidcDiscoveryUrl: hostEndpoint(
      oidcIssuer,
      "/.well-known/openid-configuration",
    ),
  };
}

async function fetchOptionalJson<T>(
  fetcher: FetchLike,
  url: string,
): Promise<T | undefined> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Discovery request failed: ${response.status} ${url}`);
  }
  return (await response.json()) as T;
}

function detectProduct(
  takosumi: TakosumiWellKnown | undefined,
  capabilities: HostCapabilities | undefined,
  product: ProductWellKnown | undefined,
): MobileProductKind | undefined {
  return (
    parseMobileProductKind(product?.product) ??
    parseMobileProductKind(takosumi?.product) ??
    parseMobileProductKind(
      typeof capabilities?.product === "string"
        ? capabilities.product
        : capabilities?.product?.kind,
    )
  );
}

function readIdentityIssuer(
  capabilities: HostCapabilities | undefined,
): string | undefined {
  return typeof capabilities?.identity?.issuer === "string"
    ? capabilities.identity.issuer
    : undefined;
}

function readTakosumiIssuer(
  takosumi: TakosumiWellKnown | undefined,
): string | undefined {
  return typeof takosumi?.issuer === "string"
    ? takosumi.issuer
    : takosumi?.endpoints && typeof takosumi.endpoints.oidc_issuer === "string"
      ? takosumi.endpoints.oidc_issuer
      : undefined;
}
