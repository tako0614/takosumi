import { base64UrlEncodeBytes, base64UrlEncodeJson } from "./encoding.ts";

export async function signEs256Jwt(input: {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  privateKey: CryptoKey;
}): Promise<string> {
  const signingInput = [
    base64UrlEncodeJson(input.header),
    base64UrlEncodeJson(input.claims),
  ].join(".");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}
