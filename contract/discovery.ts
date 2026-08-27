/**
 * Curated public discovery contract for independent Takosumi clients.
 *
 * This subpath deliberately omits the internal and retired route taxonomies
 * that share the source-tree `api-surface.ts` module.
 */
export {
  API_V1_PREFIX,
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "./api-surface.ts";

export {
  TAKOSUMI_API_VERSION,
  TAKOSUMI_INTERFACES_CAPABILITY,
  TAKOSUMI_OPERATOR_CAPABILITY_KEYS,
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
} from "./capabilities.ts";
export type {
  CreateTakosumiDiscoveryOptions,
  KnownTakosumiOperatorCapability,
  TakosumiAdapterCapabilities,
  TakosumiIdentityCapabilities,
  TakosumiOperatorCapabilities,
  TakosumiProductCapabilities,
  TakosumiResourceCapabilities,
  TakosumiWellKnownDocument,
  TakosumiWellKnownEndpoints,
  TakosumiWellKnownFeatures,
} from "./capabilities.ts";
