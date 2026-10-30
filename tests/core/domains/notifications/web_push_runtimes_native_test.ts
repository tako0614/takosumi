import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { base64UrlEncode } from "../../../../core/domains/notifications/web_push/bytes.ts";
import { deriveVapidKeyPair } from "../../../../core/domains/notifications/web_push/vapid.ts";

// The sender relies on WebCrypto computing the public point of a PKCS#8
// P-256 key that omits it. Prove that, the VAPID derivation and the RFC 8291
// Appendix A vector in the runtimes Takosumi runs on: workerd (Cloudflare),
// Node and Bun (node-postgres).

const PASSPHRASE = "fixture-only-secret-store-passphrase-0123456789";
const EXPECTED = {
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function moduleUrl(path: string): string {
  return JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
}

const PROBE = `
import { base64UrlDecode, base64UrlEncode } from ${moduleUrl("../../../../core/domains/notifications/web_push/bytes.ts")};
import { p256KeyMaterialFromScalar, isP256PublicPoint } from ${moduleUrl("../../../../core/domains/notifications/web_push/p256.ts")};
import { encryptWebPushPayload } from ${moduleUrl("../../../../core/domains/notifications/web_push/encrypt.ts")};
import { instanceVapidKeyPair } from ${moduleUrl("../../../../core/domains/notifications/web_push/vapid.ts")};

export async function probe() {
  const asPrivate = base64UrlDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
  const uaPrivate = base64UrlDecode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
  const as = await p256KeyMaterialFromScalar(asPrivate);
  const ua = await p256KeyMaterialFromScalar(uaPrivate);
  const senderPrivate = await crypto.subtle.importKey(
    "jwk", as.jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
  );
  const body = await encryptWebPushPayload({
    plaintext: new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    userAgentPublicKey: ua.publicKey,
    authSecret: base64UrlDecode("BTBZMqHH6r4Tts7J_aSIgg"),
    salt: base64UrlDecode("DGv6ra1nlYgDCS1FRnbzlw"),
    senderKeyPair: { privateKey: senderPrivate, publicKey: as.publicKey },
  });
  const offCurve = new Uint8Array(ua.publicKey);
  offCurve[64] ^= 1;
  const vapid = await instanceVapidKeyPair({ TAKOSUMI_SECRET_STORE_PASSPHRASE: ${JSON.stringify(PASSPHRASE)} });
  return {
    asPublic: base64UrlEncode(as.publicKey),
    uaPublic: base64UrlEncode(ua.publicKey),
    body: base64UrlEncode(body),
    offCurveRejected: !(await isP256PublicPoint(offCurve)),
    vapidPublic: vapid.publicKeyBase64Url,
  };
}
`;

async function bundle(root: string, entry: string, target: "browser" | "node"): Promise<string> {
  const path = join(root, `web-push-probe-${target}.ts`);
  await writeFile(path, entry);
  const result = await Bun.build({
    entrypoints: [path],
    target,
    format: "esm",
    write: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(`web push probe bundle failed for ${target}`);
  }
  return await result.outputs[0]!.text();
}

async function expected() {
  const vapid = await deriveVapidKeyPair(new TextEncoder().encode(PASSPHRASE));
  return { ...EXPECTED, offCurveRejected: true, vapidPublic: base64UrlEncode(vapid.publicKey) };
}

test("workerd computes the same P-256 points, VAPID key and RFC 8291 message", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-web-push-workerd-"));
  try {
    const probe = await bundle(root, `${PROBE}
export default { async fetch() { return Response.json(await probe()); } };
`, "browser");
    const mf = new Miniflare({
      modules: true,
      script: probe,
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
    });
    try {
      const response = await mf.dispatchFetch("http://probe.test/");
      expect(await response.json()).toEqual(await expected());
    } finally {
      await mf.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test("Node computes the same P-256 points, VAPID key and RFC 8291 message", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("node is required for the Node runtime check");
  const root = await mkdtemp(join(tmpdir(), "takosumi-web-push-node-"));
  try {
    const probe = await bundle(root, `${PROBE}
console.log(JSON.stringify(await probe()));
`, "node");
    const script = join(root, "probe.mjs");
    await writeFile(script, probe);
    const child = Bun.spawn([node, script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual(await expected());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
