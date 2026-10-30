import { describe, expect, test } from "bun:test";

import {
  base64UrlDecode,
  base64UrlEncode,
} from "../../../../core/domains/notifications/web_push/bytes.ts";
import {
  decideWebPushDelivery,
  deliverWebPushToPusher,
  webPushRetrySchedule,
  type WebPushPusherHealthPort,
} from "../../../../core/domains/notifications/web_push/delivery.ts";
import {
  encryptWebPushPayload,
  MAX_WEB_PUSH_PLAINTEXT_BYTES,
} from "../../../../core/domains/notifications/web_push/encrypt.ts";
import {
  isP256PublicPoint,
  p256KeyMaterialFromScalar,
} from "../../../../core/domains/notifications/web_push/p256.ts";
import {
  classifyWebPushResponse,
  sendWebPush,
} from "../../../../core/domains/notifications/web_push/send.ts";
import {
  clearVapidJwtCache,
  deriveVapidKeyPair,
  deriveVapidPrivateScalar,
  instanceVapidKeyPair,
  normalizeVapidSubject,
  TAKOSUMI_WEB_PUSH_VAPID_LABEL,
  vapidAuthorization,
  VAPID_JWT_LIFETIME_SECONDS,
  type VapidKeyPair,
} from "../../../../core/domains/notifications/web_push/vapid.ts";
import {
  createTestUserAgent,
  decryptWebPushBody,
  importEcdhPrivateScalar,
  verifyVapidAuthorization,
} from "../../../helpers/web_push_receiver.ts";

function b64(value: string): Uint8Array {
  const bytes = base64UrlDecode(value);
  if (!bytes) throw new Error(`bad base64url fixture: ${value}`);
  return bytes;
}

// RFC 8291 §5 and Appendix A.
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
} as const;

const PASSPHRASE = "fixture-only-secret-store-passphrase-0123456789";
const RELAY = "https://relay.example.test";
const ENDPOINT = `${RELAY}/push/endpoint-1`;
const INSTANCE = "https://takosumi.example.test";

describe("RFC 8291 encryption", () => {
  test("reproduces the Appendix A message byte for byte", async () => {
    const senderPublic = b64(RFC8291.asPublic);
    const body = await encryptWebPushPayload({
      plaintext: new TextEncoder().encode(RFC8291.plaintext),
      userAgentPublicKey: b64(RFC8291.uaPublic),
      authSecret: b64(RFC8291.authSecret),
      salt: b64(RFC8291.salt),
      senderKeyPair: {
        privateKey: await importEcdhPrivateScalar(b64(RFC8291.asPrivate)),
        publicKey: senderPublic,
      },
    });
    expect(base64UrlEncode(body)).toBe(RFC8291.body);
  });

  test("the Appendix A user agent decrypts the vector", async () => {
    const plaintext = await decryptWebPushBody(b64(RFC8291.body), {
      privateKey: await importEcdhPrivateScalar(b64(RFC8291.uaPrivate)),
      p256dh: b64(RFC8291.uaPublic),
      auth: b64(RFC8291.authSecret),
    });
    expect(new TextDecoder().decode(plaintext)).toBe(RFC8291.plaintext);
  });

  test("a fresh salt and ephemeral key round-trip and never repeat", async () => {
    const agent = await createTestUserAgent();
    const plaintext = new TextEncoder().encode("承認を待っています");
    const first = await encryptWebPushPayload({
      plaintext,
      userAgentPublicKey: agent.p256dh,
      authSecret: agent.auth,
    });
    const second = await encryptWebPushPayload({
      plaintext,
      userAgentPublicKey: agent.p256dh,
      authSecret: agent.auth,
    });
    expect(base64UrlEncode(first)).not.toBe(base64UrlEncode(second));
    expect(new DataView(first.buffer).getUint32(16)).toBe(4096);
    expect(first[20]).toBe(65);
    expect(first.byteLength).toBe(86 + plaintext.byteLength + 1 + 16);
    expect(new TextDecoder().decode(await decryptWebPushBody(first, agent)))
      .toBe("承認を待っています");
  });

  test("refuses an off-curve key, a short auth secret and oversized plaintext", async () => {
    const agent = await createTestUserAgent();
    const offCurve = new Uint8Array(agent.p256dh);
    offCurve[64]! ^= 1;
    await expect(encryptWebPushPayload({
      plaintext: new Uint8Array(1),
      userAgentPublicKey: offCurve,
      authSecret: agent.auth,
    })).rejects.toThrow("p256dh");
    await expect(encryptWebPushPayload({
      plaintext: new Uint8Array(1),
      userAgentPublicKey: agent.p256dh,
      authSecret: new Uint8Array(15),
    })).rejects.toThrow("auth");
    await expect(encryptWebPushPayload({
      plaintext: new Uint8Array(MAX_WEB_PUSH_PLAINTEXT_BYTES + 1),
      userAgentPublicKey: agent.p256dh,
      authSecret: agent.auth,
    })).rejects.toThrow("exceeds");
  });
});

describe("P-256 without curve arithmetic", () => {
  test("PKCS#8 without the public key yields the published RFC 8291 points", async () => {
    expect(base64UrlEncode(
      (await p256KeyMaterialFromScalar(b64(RFC8291.asPrivate))).publicKey,
    )).toBe(RFC8291.asPublic);
    expect(base64UrlEncode(
      (await p256KeyMaterialFromScalar(b64(RFC8291.uaPrivate))).publicKey,
    )).toBe(RFC8291.uaPublic);
  });

  test("on-curve check accepts real points and refuses the rest", async () => {
    const agent = await createTestUserAgent();
    expect(await isP256PublicPoint(agent.p256dh)).toBe(true);
    const offCurve = new Uint8Array(agent.p256dh);
    offCurve[40]! ^= 1;
    expect(await isP256PublicPoint(offCurve)).toBe(false);
    expect(await isP256PublicPoint(agent.p256dh.subarray(0, 64))).toBe(false);
    const compressed = new Uint8Array(agent.p256dh);
    compressed[0] = 0x02;
    expect(await isP256PublicPoint(compressed)).toBe(false);
  });
});

describe("VAPID key", () => {
  test("is derived deterministically from the passphrase under the label", async () => {
    const secret = new TextEncoder().encode(PASSPHRASE);
    const first = await deriveVapidKeyPair(secret);
    const second = await deriveVapidKeyPair(secret);
    expect(first.publicKeyBase64Url).toBe(second.publicKeyBase64Url);
    expect(first.publicKey.byteLength).toBe(65);
    expect(await isP256PublicPoint(first.publicKey)).toBe(true);
    const otherLabel = await deriveVapidKeyPair(secret, "takosumi/web-push/vapid/v2");
    expect(otherLabel.publicKeyBase64Url).not.toBe(first.publicKeyBase64Url);
    const otherSecret = await deriveVapidKeyPair(
      new TextEncoder().encode(`${PASSPHRASE}-rotated`),
    );
    expect(otherSecret.publicKeyBase64Url).not.toBe(first.publicKeyBase64Url);
    expect(TAKOSUMI_WEB_PUSH_VAPID_LABEL).toBe("takosumi/web-push/vapid/v1");
  });

  test("the scalar is HKDF-SHA256 over label || 0x00 || counter", async () => {
    const secret = new TextEncoder().encode(PASSPHRASE);
    const ikm = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
    const info = new Uint8Array([
      ...new TextEncoder().encode(TAKOSUMI_WEB_PUSH_VAPID_LABEL),
      0x00,
      0x00,
    ]);
    const expected = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
      ikm,
      256,
    ));
    expect(base64UrlEncode(await deriveVapidPrivateScalar(secret)))
      .toBe(base64UrlEncode(expected));
  });

  test("the instance key comes from the secret-store passphrase, else none", async () => {
    const fromPassphrase = await instanceVapidKeyPair({
      TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
    });
    const direct = await deriveVapidKeyPair(new TextEncoder().encode(PASSPHRASE));
    expect(fromPassphrase?.publicKeyBase64Url).toBe(direct.publicKeyBase64Url);
    // Same precedence as the secret store: the passphrase wins over the key.
    expect((await instanceVapidKeyPair({
      TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
      TAKOSUMI_SECRET_STORE_KEY: `${PASSPHRASE}-key`,
    }))?.publicKeyBase64Url).toBe(direct.publicKeyBase64Url);
    expect((await instanceVapidKeyPair({
      TAKOSUMI_SECRET_STORE_KEY: PASSPHRASE,
    }))?.publicKeyBase64Url).toBe(direct.publicKeyBase64Url);
    expect(await instanceVapidKeyPair({})).toBeNull();
    expect(await instanceVapidKeyPair({ TAKOSUMI_SECRET_STORE_PASSPHRASE: "  " }))
      .toBeNull();
    expect(await instanceVapidKeyPair({ TAKOSUMI_SECRET_STORE_PASSPHRASE: "short" }))
      .toBeNull();
  });

  test("signs an ES256 JWT for the relay origin, at most 12 hours, reused while fresh", async () => {
    clearVapidJwtCache();
    const keys = await deriveVapidKeyPair(new TextEncoder().encode(PASSPHRASE));
    const now = Date.UTC(2026, 9, 30, 0, 0, 0);
    const header = await vapidAuthorization(keys, { endpoint: ENDPOINT, subject: `${INSTANCE}/runs/x` }, now);
    const verified = await verifyVapidAuthorization(header);
    expect(verified.publicKey).toBe(keys.publicKeyBase64Url);
    expect(verified.claims).toEqual({
      aud: RELAY,
      exp: now / 1000 + VAPID_JWT_LIFETIME_SECONDS,
      sub: INSTANCE,
    });
    expect(VAPID_JWT_LIFETIME_SECONDS).toBeLessThanOrEqual(12 * 60 * 60);
    // Reused within its validity, re-signed once less than an hour remains.
    expect(await vapidAuthorization(keys, { endpoint: `${RELAY}/push/other`, subject: INSTANCE }, now + 60_000))
      .toBe(header);
    const later = now + (VAPID_JWT_LIFETIME_SECONDS - 30 * 60) * 1000;
    expect(await vapidAuthorization(keys, { endpoint: ENDPOINT, subject: INSTANCE }, later))
      .not.toBe(header);
  });

  test("the subject must be the instance's https origin", () => {
    expect(normalizeVapidSubject("https://takosumi.example.test/x?y")).toBe(INSTANCE);
    expect(normalizeVapidSubject("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => normalizeVapidSubject("http://takosumi.example.test")).toThrow();
    expect(() => normalizeVapidSubject("mailto:ops@example.test")).toThrow();
  });
});

describe("push service answers", () => {
  const now = Date.UTC(2026, 9, 30);

  test("are classified as delivered, gone, retry or failed", () => {
    expect(classifyWebPushResponse(201, null, now)).toEqual({ kind: "delivered", status: 201 });
    expect(classifyWebPushResponse(404, null, now)).toEqual({ kind: "gone", status: 404 });
    expect(classifyWebPushResponse(410, null, now)).toEqual({ kind: "gone", status: 410 });
    for (const status of [408, 429, 500, 502, 503]) {
      expect(classifyWebPushResponse(status, null, now).kind).toBe("retry");
    }
    for (const status of [0, 301, 302, 400, 401, 403, 413, 415]) {
      expect(classifyWebPushResponse(status, null, now).kind).toBe("failed");
    }
  });

  test("honour Retry-After in seconds or as a date", () => {
    expect(classifyWebPushResponse(429, "120", now)).toMatchObject({ retryAfterSeconds: 120 });
    expect(classifyWebPushResponse(503, new Date(now + 90_000).toUTCString(), now))
      .toMatchObject({ retryAfterSeconds: 90 });
    expect(classifyWebPushResponse(503, "soon", now)).toMatchObject({ retryAfterSeconds: 0 });
  });

  test("retry on a schedule from 30 seconds to 1 hour and stop at the TTL", () => {
    const schedule = webPushRetrySchedule(() => 1);
    const expiresAt = now + 86_400_000;
    const retry = { kind: "retry", status: 503, retryAfterSeconds: 0, error: "x" } as const;
    const first = decideWebPushDelivery(retry, { attempts: 0, now, expiresAt }, schedule);
    expect(first).toMatchObject({ kind: "retry", attemptsMade: 1, at: now + 30_000 });
    const tenth = decideWebPushDelivery(retry, { attempts: 9, now, expiresAt }, schedule);
    expect(tenth).toMatchObject({ kind: "retry", attemptsMade: 10, at: now + 3_600_000 });
    const minimum = decideWebPushDelivery(retry, { attempts: 0, now, expiresAt }, webPushRetrySchedule(() => 0));
    expect(minimum).toMatchObject({ kind: "retry", at: now + 30_000 });
    expect(decideWebPushDelivery(retry, { attempts: 9, now, expiresAt: now + 60_000 }, schedule))
      .toMatchObject({ kind: "expired", status: 503 });
    expect(decideWebPushDelivery(
      { kind: "retry", status: 429, retryAfterSeconds: 600, error: "x" },
      { attempts: 0, now, expiresAt },
      schedule,
    )).toMatchObject({ kind: "retry", at: now + 600_000 });
    expect(decideWebPushDelivery({ kind: "failed", status: 403, error: "x" }, { attempts: 0, now, expiresAt }))
      .toMatchObject({ kind: "failed", status: 403 });
    expect(decideWebPushDelivery({ kind: "gone", status: 410 }, { attempts: 0, now, expiresAt }))
      .toEqual({ kind: "pusher_removed", status: 410 });
  });
});

describe("sending to a relay", () => {
  async function fixture() {
    clearVapidJwtCache();
    const vapid = await deriveVapidKeyPair(new TextEncoder().encode(PASSPHRASE));
    const agent = await createTestUserAgent();
    return { vapid, agent };
  }

  function relay(
    answer: (request: Request) => Response | Promise<Response>,
  ): { fetch: typeof fetch; requests: Request[] } {
    const requests: Request[] = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return await answer(request);
    }) as typeof fetch;
    return { fetch: fake, requests };
  }

  test("posts an encrypted aes128gcm body with VAPID, TTL, Urgency and Topic", async () => {
    const { vapid, agent } = await fixture();
    const fake = relay(() => new Response(null, { status: 201 }));
    const outcome = await sendWebPush(
      { endpoint: ENDPOINT, p256dh: agent.p256dh, auth: agent.auth },
      { payload: "{\"web_push\":8030}", ttlSeconds: 86_400, urgency: "high", topic: "run_123" },
      { vapid, subject: INSTANCE, fetch: fake.fetch },
    );
    expect(outcome).toEqual({ kind: "delivered", status: 201 });
    const [request] = fake.requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(ENDPOINT);
    expect(request!.redirect).toBe("manual");
    expect(request!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(request!.headers.get("ttl")).toBe("86400");
    expect(request!.headers.get("urgency")).toBe("high");
    expect(request!.headers.get("topic")).toBe("run_123");
    const verified = await verifyVapidAuthorization(request!.headers.get("authorization"));
    expect(verified.publicKey).toBe(vapid.publicKeyBase64Url);
    expect(verified.claims.aud).toBe(RELAY);
    const body = new Uint8Array(await request!.arrayBuffer());
    expect(new TextDecoder().decode(await decryptWebPushBody(body, agent)))
      .toBe("{\"web_push\":8030}");
  });

  test("a network error or timeout is retried; a bad Topic fails without a request", async () => {
    const { vapid, agent } = await fixture();
    const target = { endpoint: ENDPOINT, p256dh: agent.p256dh, auth: agent.auth };
    const unreachable = relay(() => { throw new TypeError("connection refused"); });
    expect(await sendWebPush(target, { payload: "x", ttlSeconds: 60 }, { vapid, subject: INSTANCE, fetch: unreachable.fetch }))
      .toMatchObject({ kind: "retry", status: null });
    const slow = relay((request) => new Promise<Response>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    expect(await sendWebPush(target, { payload: "x", ttlSeconds: 60 }, { vapid, subject: INSTANCE, fetch: slow.fetch, timeoutMs: 20 }))
      .toMatchObject({ kind: "retry", error: "push service timed out" });
    const never = relay(() => new Response(null, { status: 201 }));
    expect(await sendWebPush(target, { payload: "x", ttlSeconds: 60, topic: "not a topic!" }, { vapid, subject: INSTANCE, fetch: never.fetch }))
      .toMatchObject({ kind: "failed", status: null });
    expect(never.requests).toHaveLength(0);
  });

  test("applies each answer to the pusher: delete on 404/410, failure on 403/413, nothing on 5xx", async () => {
    const { vapid, agent } = await fixture();
    const now = Date.UTC(2026, 9, 30);
    const calls: string[] = [];
    const pushers: WebPushPusherHealthPort = {
      removePusher: (id) => { calls.push(`remove:${id}`); return Promise.resolve(); },
      recordPusherDelivered: (id, at) => { calls.push(`ok:${id}:${at}`); return Promise.resolve(); },
      recordPusherFailed: (id, at, status) => { calls.push(`fail:${id}:${at}:${status}`); return Promise.resolve(); },
    };
    const deliver = async (status: number, attempts = 0, expiresAt = now + 86_400_000) => {
      const fake = relay(() => new Response(null, { status }));
      return await deliverWebPushToPusher({
        target: { pusherId: "npsh_x", endpoint: ENDPOINT, p256dh: agent.p256dh, auth: agent.auth },
        message: { payload: "x", ttlSeconds: 86_400 },
        context: { vapid, subject: INSTANCE, fetch: fake.fetch, now: () => now },
        pushers,
        retry: { attempts, expiresAt },
        schedule: webPushRetrySchedule(() => 0),
      });
    };
    expect(await deliver(201)).toEqual({ kind: "delivered", status: 201 });
    expect(await deliver(410)).toEqual({ kind: "pusher_removed", status: 410 });
    expect(await deliver(404)).toEqual({ kind: "pusher_removed", status: 404 });
    expect(await deliver(403)).toMatchObject({ kind: "failed", status: 403 });
    expect(await deliver(413)).toMatchObject({ kind: "failed", status: 413 });
    expect(await deliver(503)).toMatchObject({ kind: "retry", attemptsMade: 1, at: now + 30_000 });
    expect(await deliver(503, 3, now + 1_000)).toMatchObject({ kind: "expired", status: 503 });
    expect(calls).toEqual([
      `ok:npsh_x:${now}`,
      "remove:npsh_x",
      "remove:npsh_x",
      `fail:npsh_x:${now}:403`,
      `fail:npsh_x:${now}:413`,
      `fail:npsh_x:${now}:503`,
    ]);
  });
});

test("a derived key pair signs with a non-extractable private key", async () => {
  const keys: VapidKeyPair = await deriveVapidKeyPair(new TextEncoder().encode(PASSPHRASE));
  expect(keys.privateKey.extractable).toBe(false);
  expect(keys.privateKey.usages).toEqual(["sign"]);
});
