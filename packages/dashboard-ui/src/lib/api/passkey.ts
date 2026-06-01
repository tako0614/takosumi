import { apiFetch } from "./client";

export interface PasskeyRegisterOptions {
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly displayName: string;
  };
  readonly challenge: string;
  readonly pubKeyCredParams?: readonly {
    readonly alg: number;
    readonly type: "public-key";
  }[];
  readonly timeout?: number;
  readonly attestation?: AttestationConveyancePreference;
  readonly excludeCredentials?: readonly {
    readonly id: string;
    readonly type: "public-key";
  }[];
  readonly authenticatorSelection?: AuthenticatorSelectionCriteria;
}

export async function requestPasskeyRegisterOptions(
  subject: string,
): Promise<PasskeyRegisterOptions> {
  return await apiFetch<PasskeyRegisterOptions>(
    "/v1/auth/passkeys/register/options",
    { method: "POST", body: { subject } },
  );
}

export async function completePasskeyRegistration(input: {
  subject: string;
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  /**
   * The server-minted challenge echoed back from the register/options
   * response. The server requires this so it can confirm the ceremony is
   * the one it issued (replay protection) and unlock clientDataJSON /
   * attestationObject verification on the complete endpoint.
   */
  challenge: string;
  /**
   * base64url-encoded `clientDataJSON` from the authenticator's
   * `navigator.credentials.create()` result. The server parses it and
   * checks `type === "webauthn.create"`, the challenge, and the origin.
   */
  clientDataJSON: string;
  /**
   * base64url-encoded `attestationObject` from the authenticator. The
   * server enforces that its `fmt` matches the requested attestation
   * policy ("none").
   */
  attestationObject: string;
  signCount?: number;
  transports?: readonly string[];
}): Promise<{ credential_id: string; subject: string; sign_count: number }> {
  return await apiFetch("/v1/auth/passkeys/register/complete", {
    method: "POST",
    body: input,
  });
}
