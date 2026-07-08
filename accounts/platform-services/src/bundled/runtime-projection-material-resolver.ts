/**
 * Takosumi runtime projection material helpers.
 *
 * This package intentionally exports a platform service resolver, not an
 * OIDC component kind. Operators that run Takosumi and Takos in
 * one distribution can pass the returned object to
 * `createTakosumiService({ platformServices })`.
 */
export {
  createTakosumiRuntimeProjectionMaterialResolver,
  resolveTakosumiRuntimeProjectionMaterial,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  type TakosumiRuntimeProjectionMaterialResolverOptions,
  type RuntimeProjectionMaterial,
  type RuntimeProjectionMaterialResolveContext,
  type RuntimeProjectionMaterialResolver,
  type RuntimeProjectionMaterialSecret,
} from "@takosjp/takosumi-accounts-service";
