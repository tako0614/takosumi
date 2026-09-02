/**
 * Accounts authority for OIDC values delivered through run-scoped sensitive
 * provider inputs.
 *
 * A Capsule whose manifest requests `identity.oidc` with binding delivery needs
 * four values — issuer, client id, owner subject, redirect URI — inside the map
 * the Takoform provider receives at Apply. Those values are not this lane's to
 * invent: they belong to the ONE public OIDC client the Capsule already has
 * under Takosumi Accounts, the same registration the private Takoserver
 * runtime-binding lane resolves. This module is therefore a thin composition of
 * the shared registration code path
 * ({@link ./accounts_oidc_client_registration.ts}) and the shared client-id
 * preimage ({@link ./runtime_binding_materializer.ts}), not a second minting
 * site: both lanes derive the same client id from the same host key, and the
 * Accounts store refuses a second client under one Capsule anyway.
 *
 * Plan validates the registration read-only and Apply completes it, exactly as
 * the module-variable lane does. `generation` is the value-free identity Core
 * folds into the provider nonce: it is a digest, never a value, and it moves if
 * and only if one of the four delivered values would.
 *
 * The public origin is host knowledge, not Capsule state. A binding-delivered
 * OIDC grant carries no repository-declared endpoint (the manifest compiler
 * rejects one), because the origin is assigned by whichever host publishes the
 * Worker. The host therefore supplies it here; a host that cannot fails closed
 * rather than registering a redirect URI nothing will serve.
 */

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { oidcClientActivationDigest } from "../../accounts/service/src/oidc-activation.ts";
import { oidcAllowedScopes } from "../../accounts/service/src/oidc-live-grant.ts";
import type { Capsule } from "../../contract/capsules.ts";
import type {
  InstallConfig,
  RuntimeOidcClientBindings,
} from "../../contract/install-configs.ts";
import { installExperienceOidcClient } from "../../contract/install-experience.ts";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";
import type {
  RuntimeInputOidcClientSource,
  RuntimeInputOidcRequest,
} from "../../core/domains/deploy-control/runtime_input_materializer.ts";
import {
  deriveCapsulePublicOidcClientIdentity,
  derivePublicOidcClientId,
  registerCapsulePublicOidcClient,
  validateCapsulePublicOidcClientRegistration,
  type CapsuleOidcAccountsLedger,
} from "./accounts_oidc_client_registration.ts";
import {
  runtimeOidcClientDerivationParts,
  type RuntimeBindingProfileContract,
} from "./runtime_binding_materializer.ts";

const GENERATION_CONTRACT = "takosumi.runtime-input-oidc-generation/v1";
const PROFILE_CONTRACT_V1 = "takosumi.runtime-binding-profile/v1";
const PROFILE_CONTRACT_V2 = "takosumi.runtime-binding-profile/v2";
const SUBJECT = /^tsub_[A-Za-z0-9_-]{1,128}$/u;

export interface RuntimeInputOidcControlLedger {
  getCapsule(id: string): Promise<Capsule | undefined>;
  getInstallConfig(id: string): Promise<InstallConfig | undefined>;
  getCapsuleExecutionAuthorityEpoch(id: string): Promise<number | undefined>;
}

/**
 * Host authority for the origin the Capsule's Worker is published under.
 *
 * Returning `undefined` (or throwing) fails the lane closed: the Capsule keeps
 * its plan error instead of registering a redirect URI for an origin nobody
 * serves.
 */
export type RuntimeInputCapsulePublicOrigin = (input: {
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
}) => Promise<string | undefined>;

/**
 * Teardown half of {@link RuntimeInputCapsulePublicOrigin}.
 *
 * A host that fixes an origin before Plan holds it for this Capsule until it is
 * told to stop. Nothing else in Takosumi knows the host is holding anything, so
 * an unreleased origin stays pinned forever. It runs only after the Capsule is
 * destroyed and never throws.
 */
export type RuntimeInputCapsulePublicOriginRelease = (input: {
  readonly workspaceId: string;
  readonly capsuleId: string;
}) => Promise<void>;

export function createTakosumiRuntimeInputOidcClientSource(input: {
  readonly control: RuntimeInputOidcControlLedger;
  readonly accounts: CapsuleOidcAccountsLedger;
  readonly issuer: string;
  readonly pairwiseSubjectSecret: string;
  /** Same host key the private runtime-binding lane derives its client from. */
  readonly derivationKey: string;
  readonly capsulePublicOrigin: RuntimeInputCapsulePublicOrigin;
  /**
   * Optional teardown for whatever the host holds to keep that origin fixed.
   * Absent it, a destroyed Capsule's origin stays reserved forever.
   */
  readonly capsulePublicOriginRelease?: RuntimeInputCapsulePublicOriginRelease;
  readonly clock?: () => Date;
}): RuntimeInputOidcClientSource {
  const issuer = exactHttpsOrigin(input.issuer);
  const pairwiseSubjectSecret = boundedSecret(
    input.pairwiseSubjectSecret,
    "pairwiseSubjectSecret",
  );
  const derivationKey = boundedSecret(input.derivationKey, "derivationKey");
  const clock = input.clock ?? (() => new Date());

  const resolve = async (request: RuntimeInputOidcRequest) => {
    const contract = exactProfileContract(request.profileContract);
    const capsule = await input.control.getCapsule(request.capsuleId);
    if (
      !capsule ||
      capsule.id !== request.capsuleId ||
      capsule.workspaceId !== request.workspaceId ||
      capsule.installConfigId !== request.installConfigId ||
      capsule.status === "destroyed"
    ) {
      invalid("runtime input OIDC Capsule is not current");
    }
    const config = await input.control.getInstallConfig(
      capsule.installConfigId,
    );
    if (
      !config ||
      config.id !== capsule.installConfigId ||
      config.workspaceId !== request.workspaceId
    ) {
      invalid("runtime input OIDC InstallConfig is not current");
    }
    // The DB-owned profile is the authority; Core's declaration only names what
    // it expects to receive. A disagreement means the two are describing
    // different grants, which must never silently resolve to either one.
    const profile = config.runtimeBindingMaterialization;
    if (
      !profile ||
      profile.contract !== contract ||
      !sameOidcBindings(profile.oidcClient, request.bindings)
    ) {
      invalid("runtime input OIDC profile is not current");
    }
    const callbackPath = exactCallbackPath(request.bindings.callbackPath);
    const scopes = oidcAllowedScopes(request.bindings.scopes);
    const grantDeclarations =
      config.installExperience?.projections?.filter(
        (projection) => projection.kind === "oidc_client",
      ) ?? [];
    const grant = installExperienceOidcClient(config.installExperience);
    if (
      grantDeclarations.length !== 1 ||
      Object.keys(grantDeclarations[0]!.variables).length !== 0 ||
      !grant ||
      grant.callbackPath !== callbackPath ||
      !sameStrings(oidcAllowedScopes(grant.scopes), scopes)
    ) {
      invalid("runtime input OIDC grant differs from the DB-owned profile");
    }
    const installingPrincipalId = capsule.installingPrincipalId;
    if (
      typeof installingPrincipalId !== "string" ||
      !SUBJECT.test(installingPrincipalId)
    ) {
      invalid("runtime input OIDC installing Principal is missing");
    }
    const publicOrigin = exactHttpsOrigin(
      (await input.capsulePublicOrigin({ capsule, installConfig: config })) ??
        "",
    );
    const clientId = await derivePublicOidcClientId(
      derivationKey,
      runtimeOidcClientDerivationParts(contract, request, config.id),
    );
    const registration = {
      accounts: input.accounts,
      capsule,
      installingPrincipalId: installingPrincipalId as TakosumiSubject,
      issuer,
      publicOrigin,
      callbackPath,
      scopes,
      clientId,
      pairwiseSubjectSecret,
    };
    const identity = await deriveCapsulePublicOidcClientIdentity(registration);
    return { capsule, config, registration, identity };
  };

  const delivered = (
    bindings: RuntimeOidcClientBindings,
    identity: {
      readonly clientId: string;
      readonly ownerSubject: string;
      readonly redirectUri: string;
    },
  ): Readonly<Record<string, string>> => ({
    [bindings.issuerBinding]: issuer,
    [bindings.clientIdBinding]: identity.clientId,
    [bindings.ownerSubjectBinding]: identity.ownerSubject,
    [bindings.redirectUriBinding]: identity.redirectUri,
  });

  /**
   * Value-free generation identity.
   *
   * It digests the delivered identity rather than the inputs that produce it,
   * so a rotated Accounts authority — a new pairwise subject secret, a new
   * derivation key — moves it too. A SHA-256 of a public client id, a pairwise
   * pseudonym, an issuer, and a redirect URI reveals none of them, and it only
   * ever reaches the nonce preimage, which is itself a digest.
   */
  const generationDigest = async (
    bindings: RuntimeOidcClientBindings,
    values: Readonly<Record<string, string>>,
  ): Promise<string> =>
    await stableJsonDigest({
      contract: GENERATION_CONTRACT,
      bindings: [
        bindings.issuerBinding,
        bindings.clientIdBinding,
        bindings.ownerSubjectBinding,
        bindings.redirectUriBinding,
      ],
      callbackPath: bindings.callbackPath,
      values,
    });

  const assertRegistered = (
    registered: { readonly clientId: string; readonly ownerSubject: string; readonly redirectUri: string },
    identity: { readonly clientId: string; readonly ownerSubject: string; readonly redirectUri: string },
  ): void => {
    if (
      registered.clientId !== identity.clientId ||
      registered.ownerSubject !== identity.ownerSubject ||
      registered.redirectUri !== identity.redirectUri
    ) {
      invalid(
        "runtime input OIDC registration differs from the derived identity",
      );
    }
  };

  return {
    async generation(request) {
      const { capsule, config, registration, identity } = await resolve(request);
      // Read-only: Plan may not create or move an Accounts registration, but a
      // registration that already contradicts this identity must stop the plan
      // rather than be reviewed as if it agreed.
      assertRegistered(
        (
          await validateCapsulePublicOidcClientRegistration({
            ...registration,
            activationDigest: await activationDigest(
              input.control,
              capsule,
              config,
            ),
          })
        ).identity,
        identity,
      );
      return await generationDigest(
        request.bindings,
        delivered(request.bindings, identity),
      );
    },
    async materialize(request) {
      const { capsule, config, registration, identity } = await resolve(request);
      const registered = await registerCapsulePublicOidcClient({
        ...registration,
        activationDigest: await activationDigest(input.control, capsule, config),
        clock,
      });
      assertRegistered(registered, identity);
      const values = delivered(request.bindings, registered);
      return {
        generation: await generationDigest(request.bindings, values),
        values,
      };
    },
    ...(input.capsulePublicOriginRelease
      ? {
          async retire(authority) {
            // Best-effort by contract: the destroy that reaches here has
            // already succeeded, and a host that cannot be told to let go of an
            // origin must not turn a finished teardown into a failed one.
            await input.capsulePublicOriginRelease!({
              workspaceId: authority.workspaceId,
              capsuleId: authority.capsuleId,
            });
          },
        }
      : {}),
  };
}

async function activationDigest(
  control: RuntimeInputOidcControlLedger,
  capsule: Capsule,
  installConfig: InstallConfig,
): Promise<string> {
  const epoch = await control.getCapsuleExecutionAuthorityEpoch(capsule.id);
  if (!Number.isSafeInteger(epoch) || epoch === undefined || epoch < 1) {
    invalid("runtime input OIDC Capsule execution authority is not current");
  }
  return await oidcClientActivationDigest({
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    executionAuthorityEpoch: epoch,
    installConfig,
  });
}

function sameOidcBindings(
  current: RuntimeOidcClientBindings | undefined,
  expected: RuntimeOidcClientBindings,
): boolean {
  return Boolean(
    current &&
      current.issuerBinding === expected.issuerBinding &&
      current.clientIdBinding === expected.clientIdBinding &&
      current.ownerSubjectBinding === expected.ownerSubjectBinding &&
      current.redirectUriBinding === expected.redirectUriBinding &&
      current.callbackPath === expected.callbackPath &&
      sameStrings(current.scopes ?? [], expected.scopes ?? []),
  );
}

function exactProfileContract(value: string): RuntimeBindingProfileContract {
  if (value !== PROFILE_CONTRACT_V1 && value !== PROFILE_CONTRACT_V2) {
    invalid("runtime input OIDC profile contract is invalid");
  }
  return value;
}

function exactCallbackPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 1_024 ||
    /[\u0000-\u001f\u007f?#]/u.test(value)
  ) {
    invalid("runtime input OIDC callback path is invalid");
  }
  return value;
}

function exactHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("runtime input OIDC HTTPS origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    invalid("runtime input OIDC HTTPS origin is invalid");
  }
  return url.origin;
}

function boundedSecret(value: string, label: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 32 || bytes > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`runtime input OIDC ${label} is invalid`);
  }
  return value;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function invalid(message: string): never {
  throw new TypeError(message);
}
