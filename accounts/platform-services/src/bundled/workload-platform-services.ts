/**
 * Takosumi workload platform service helpers.
 *
 * This package intentionally exports a platform service resolver, not an
 * OIDC component kind. Operators that run Takosumi and Takosumi in
 * one distribution can pass the returned object to
 * `createTakosumiService({ platformServices })`.
 */
export {
  createTakosumiWorkloadPlatformServiceResolver,
  resolveTakosumiWorkloadPlatformService,
  TAKOSUMI_ACCOUNTS_MATERIAL_BILLING_PORT_V1,
  TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  type TakosumiWorkloadPlatformServiceResolverOptions,
  type WorkloadPlatformServiceMaterial,
  type WorkloadPlatformServiceResolveContext,
  type WorkloadPlatformServiceResolver,
  type WorkloadPlatformServiceSecret,
} from "@takosjp/takosumi-accounts-service";
