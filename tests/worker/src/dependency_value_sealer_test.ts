import { expect, test } from "bun:test";
import {
  dependencyValueSealerFromEnv,
  StateCryptoDependencyValueSealer,
} from "../../../worker/src/dependency_value_sealer.ts";
import { StateArtifactCrypto } from "../../../worker/src/state_crypto.ts";

const PASSPHRASE = "takosumi-dep-value-sealer-test-passphrase-0123456789ab";

function sealer(): StateCryptoDependencyValueSealer {
  return new StateCryptoDependencyValueSealer(
    StateArtifactCrypto.fromEnv({ TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE }),
  );
}

test("seal->unseal round-trips the sensitive value map exactly", async () => {
  const sealerInstance = sealer();
  const values = {
    admin_token: "super-secret-token",
    nested: { db_password: "p@ss/w0rd", n: 42, flag: true } as never,
  };
  const sealed = await sealerInstance.seal(values);

  // The ciphertext must not carry the plaintext secret.
  expect(sealed.ciphertext).toBeTruthy();
  expect(sealed.ciphertext).not.toContain("super-secret-token");
  // Names are cleartext metadata; values never are.
  expect(sealed.names.sort()).toEqual(["admin_token", "nested"]);

  const opened = await sealerInstance.open(sealed);
  expect(opened).toEqual(values);
});

test("a single string secret round-trips and is absent from the sealed blob", async () => {
  const sealerInstance = sealer();
  const sealed = await sealerInstance.seal({ admin_token: "super-secret-token" });
  expect(JSON.stringify(sealed)).not.toContain("super-secret-token");
  expect(await sealerInstance.open(sealed)).toEqual({
    admin_token: "super-secret-token",
  });
});

test("a tampered ciphertext fails closed at the AES-GCM auth tag", async () => {
  const sealerInstance = sealer();
  const sealed = await sealerInstance.seal({ admin_token: "super-secret-token" });
  // Flip a byte in the base64 ciphertext: opening must throw (auth-tag / digest).
  const bytes = atob(sealed.ciphertext);
  const flipped = String.fromCharCode(bytes.charCodeAt(0) ^ 0xff) +
    bytes.slice(1);
  await expect(
    sealerInstance.open({ ...sealed, ciphertext: btoa(flipped) }),
  ).rejects.toThrow();
});

test("opening with the wrong key fails closed", async () => {
  const a = sealer();
  const sealed = await a.seal({ admin_token: "super-secret-token" });
  const b = new StateCryptoDependencyValueSealer(
    StateArtifactCrypto.fromEnv({
      TAKOSUMI_SECRET_STORE_PASSPHRASE: "a-totally-different-passphrase-9876543210",
    }),
  );
  await expect(b.open(sealed)).rejects.toThrow();
});

test("dependencyValueSealerFromEnv builds a working sealer from env", async () => {
  const built = dependencyValueSealerFromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
  });
  const sealed = await built.seal({ admin_token: "super-secret-token" });
  expect(await built.open(sealed)).toEqual({
    admin_token: "super-secret-token",
  });
});
