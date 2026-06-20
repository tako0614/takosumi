import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

export interface StableSubjectInput {
  secret: string | Uint8Array | CryptoKey;
  upstreamIssuer: string;
  upstreamSubject: string;
}

export interface PairwiseSubjectInput {
  secret: string | Uint8Array | CryptoKey;
  takosumiSubject: TakosumiSubject;
  clientId: string;
}

const textEncoder = new TextEncoder();

export async function deriveTakosumiSubject(
  input: StableSubjectInput,
): Promise<TakosumiSubject> {
  const digest = await hmacSha256(input.secret, [
    "takosumi-account-subject-v1",
    normalizeSubjectPart(input.upstreamIssuer),
    normalizeSubjectPart(input.upstreamSubject),
  ]);
  return `tsub_${digest.slice(0, 32)}`;
}

export async function derivePairwiseSubject(
  input: PairwiseSubjectInput,
): Promise<TakosumiSubject> {
  const digest = await hmacSha256(input.secret, [
    "takosumi-account-pairwise-subject-v1",
    input.takosumiSubject,
    normalizeSubjectPart(input.clientId),
  ]);
  return `tsub_${digest.slice(0, 32)}`;
}

async function hmacSha256(
  secret: string | Uint8Array | CryptoKey,
  parts: readonly string[],
): Promise<string> {
  const key =
    secret instanceof CryptoKey
      ? secret
      : await crypto.subtle.importKey(
          "raw",
          rawSecretBytes(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(parts.join("\n")),
  );
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function rawSecretBytes(secret: string | Uint8Array): ArrayBuffer {
  if (typeof secret === "string") return textEncoder.encode(secret).buffer;
  return new Uint8Array(secret).buffer;
}

function normalizeSubjectPart(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError("subject derivation inputs must not be empty");
  }
  return normalized;
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
