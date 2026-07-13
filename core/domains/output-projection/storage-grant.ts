/**
 * Storage object grant resolution.
 *
 * The bind-time issuer behind a `storage.object` consume. Given a
 * consumer Capsule's projected service bindings (from {@link projectServicesFromOutputs}
 * on the consumer's outputs) and the producer `takos-storage` export + its
 * signing key, this resolves what scoped token(s) to mint and which env vars to
 * inject into the consumer.
 *
 * This is the runtime-authority piece that the Output projection contract
 * deliberately omits: projection is pure classification; here we actually decide
 * scope and mint credentials. Injection into the consumer run is done by the
 * caller (the deploy-control consumer-apply path) using the returned env map.
 */

import {
  mintServiceScopedCredential,
  type ServiceCredentialVerb,
} from "../../shared/service_scoped_credentials.ts";
import type {
  ProjectedServiceBinding,
  ProjectedServiceExport,
} from "takosumi-contract/output-projection";

export const STORAGE_OBJECT_PUBLICATION = "storage.object";

const DEFAULT_URL_ENV = "OBJECT_STORAGE_API_URL";
const DEFAULT_TOKEN_ENV = "OBJECT_STORAGE_ACCESS_TOKEN";
const DEFAULT_PREFIX_ENV = "OBJECT_STORAGE_KEY_PREFIX";

export interface StorageGrantPlan {
  /** Publication being satisfied — always {@link STORAGE_OBJECT_PUBLICATION}. */
  readonly publication: string;
  /** Producer object-API base URL, when the producer export advertises one. */
  readonly apiUrl?: string;
  /** Key prefix the minted token is confined to. */
  readonly prefix: string;
  /** Verbs derived from the consumer's requested scopes. */
  readonly verbs: readonly ServiceCredentialVerb[];
  /** Consumer env var that receives the API URL. */
  readonly urlEnvVar: string;
  /** Consumer env var that receives the minted token. */
  readonly tokenEnvVar: string;
  /** Consumer env var that receives the key prefix. */
  readonly prefixEnvVar: string;
}

export interface IssuedStorageGrant extends StorageGrantPlan {
  /** The minted scoped access token. */
  readonly token: string;
  /** Env var name -> value, ready to inject into the consumer run. */
  readonly injectEnv: Readonly<Record<string, string>>;
}

export interface StorageGrantContext {
  readonly workspaceId: string;
  readonly consumerInstallationId: string;
}

export interface StorageProducer {
  readonly export: ProjectedServiceExport;
  readonly signingKey: string;
}

/**
 * Pure: resolve the grant plans a consumer's bindings request against a
 * `storage.object` producer export. Does not mint.
 */
export function planStorageObjectGrants(
  consumerBindings: readonly ProjectedServiceBinding[],
  producerExport: ProjectedServiceExport,
  context: StorageGrantContext,
): readonly StorageGrantPlan[] {
  if (producerExport.name !== STORAGE_OBJECT_PUBLICATION) return [];
  // The `/`-joined prefix relies on slash-free ids; a `/` in either id would
  // blur prefix boundaries between consumers. Ids are server-generated
  // (space_<hex> / inst_<hex>), so this is a defensive guard, not a live path.
  if (
    !context.workspaceId ||
    !context.consumerInstallationId ||
    context.workspaceId.includes("/") ||
    context.consumerInstallationId.includes("/")
  ) {
    return [];
  }
  const apiUrl = firstEndpointUrl(producerExport);
  const prefix = `${context.workspaceId}/${context.consumerInstallationId}/`;

  const plans: StorageGrantPlan[] = [];
  for (const binding of consumerBindings) {
    if (!selectsStoragePublication(binding)) continue;
    const injectEnvNames = injectEnvNamesFromBinding(binding);
    plans.push({
      publication: STORAGE_OBJECT_PUBLICATION,
      ...(apiUrl ? { apiUrl } : {}),
      prefix,
      verbs: serviceVerbsFromScopes(binding.grantRequest.scopes),
      urlEnvVar: injectEnvNames.url ?? DEFAULT_URL_ENV,
      tokenEnvVar: injectEnvNames.token ?? DEFAULT_TOKEN_ENV,
      prefixEnvVar: injectEnvNames.prefix ?? DEFAULT_PREFIX_ENV,
    });
  }
  return plans;
}

/**
 * Resolve + mint. Returns one issued grant per matching consumer binding, each
 * carrying the env map the caller injects into the consumer run.
 */
export async function issueStorageObjectGrants(
  consumerBindings: readonly ProjectedServiceBinding[],
  producer: StorageProducer,
  context: StorageGrantContext,
  options: { readonly now?: () => number } = {},
): Promise<readonly IssuedStorageGrant[]> {
  const plans = planStorageObjectGrants(
    consumerBindings,
    producer.export,
    context,
  );
  const issued: IssuedStorageGrant[] = [];
  for (const plan of plans) {
    const minted = await mintServiceScopedCredential({
      signingKey: producer.signingKey,
      workspaceId: context.workspaceId,
      capsuleId: context.consumerInstallationId,
      prefix: plan.prefix,
      verbs: plan.verbs,
      audience: STORAGE_OBJECT_PUBLICATION,
      ...(options.now ? { now: options.now } : {}),
    });
    const injectEnv: Record<string, string> = {
      [plan.tokenEnvVar]: minted.credential,
      [plan.prefixEnvVar]: plan.prefix,
    };
    if (plan.apiUrl) injectEnv[plan.urlEnvVar] = plan.apiUrl;
    issued.push({
      ...plan,
      token: minted.credential,
      injectEnv,
    });
  }
  return issued;
}

function serviceVerbsFromScopes(
  scopes: readonly string[],
): readonly ServiceCredentialVerb[] {
  const verbs = new Set<ServiceCredentialVerb>();
  for (const scope of scopes) {
    if (scope === "files:read") {
      verbs.add("r");
      verbs.add("l");
    } else if (scope === "files:write") {
      verbs.add("r");
      verbs.add("w");
      verbs.add("d");
      verbs.add("l");
    }
  }
  if (verbs.size === 0) {
    verbs.add("r");
    verbs.add("l");
  }
  return [...verbs];
}

function selectsStoragePublication(binding: ProjectedServiceBinding): boolean {
  if (binding.selector.name === STORAGE_OBJECT_PUBLICATION) return true;
  if (binding.selector.serviceExportId === STORAGE_OBJECT_PUBLICATION)
    return true;
  return binding.selector.capabilities.includes("storage.object");
}

function firstEndpointUrl(
  exportValue: ProjectedServiceExport,
): string | undefined {
  for (const endpoint of exportValue.endpoints ?? []) {
    if (typeof endpoint.url === "string" && endpoint.url.length > 0)
      return endpoint.url;
  }
  return undefined;
}

function injectEnvNamesFromBinding(binding: ProjectedServiceBinding): {
  url?: string;
  token?: string;
  prefix?: string;
} {
  const inject = binding.grantRequest.metadata?.inject;
  if (!inject || typeof inject !== "object" || Array.isArray(inject)) return {};
  const env = (inject as { env?: unknown }).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const record = env as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : undefined;
  return { url: pick("url"), token: pick("token"), prefix: pick("prefix") };
}
