import { expect, test } from "bun:test";

import * as discovery from "../../contract/discovery.ts";
import type {
  CreateTakosumiDiscoveryOptions,
  TakosumiProductCapabilities,
  TakosumiWellKnownDocument,
} from "../../contract/discovery.ts";

test("discovery exposes only public paths and capability builders", () => {
  expect(Object.keys(discovery).sort()).toEqual([
    "API_V1_PREFIX",
    "TAKOSUMI_API_VERSION",
    "TAKOSUMI_INTERFACES_CAPABILITY",
    "TAKOSUMI_OPERATOR_CAPABILITY_KEYS",
    "TAKOSUMI_PRODUCT_CAPABILITIES_PATH",
    "TAKOSUMI_WELL_KNOWN_PATH",
    "createTakosumiProductCapabilities",
    "createTakosumiWellKnownDocument",
  ]);

  expect(discovery).not.toHaveProperty("INTERNAL_V1_PREFIX");
  expect(discovery).not.toHaveProperty("RETIRED_V1_PREFIX");
  expect(discovery).not.toHaveProperty("PROCESS_OBSERVABILITY_PATHS");
});

test("discovery builders retain the canonical Takosumi wire shapes", () => {
  const options = {
    origin: "https://host.example/",
    mobileOidcClientId: "installed-client",
    interfacesEnabled: true,
  } satisfies CreateTakosumiDiscoveryOptions;
  const document: TakosumiWellKnownDocument =
    discovery.createTakosumiWellKnownDocument(options);
  const capabilities: TakosumiProductCapabilities =
    discovery.createTakosumiProductCapabilities(options);

  expect(discovery.API_V1_PREFIX).toBe("/api/v1");
  expect(discovery.TAKOSUMI_WELL_KNOWN_PATH).toBe(
    "/.well-known/takosumi",
  );
  expect(discovery.TAKOSUMI_PRODUCT_CAPABILITIES_PATH).toBe(
    "/api/v1/capabilities",
  );
  expect(document.api_versions).toEqual([discovery.TAKOSUMI_API_VERSION]);
  expect(document.apiBaseUrl).toBe("https://host.example/api/v1");
  expect(document.oidcClientId).toBe("installed-client");
  expect(capabilities.extensions).toContain(
    discovery.TAKOSUMI_INTERFACES_CAPABILITY,
  );
});
