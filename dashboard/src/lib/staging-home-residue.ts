// Temporary staging-only presentation for verified test residue. Retain the
// deployment records and account API so operators can finish normal teardown.
// Fingerprints bind the exact Capsule id and name without publishing raw ids.
const stagingOrigin = "https://app-staging.takosumi.com";
const hidden = new Set([
  "0632e773702873f48217299e27acff9b6deec06d5fc4592ac6534d93e83f5ab7",
  "225884dd67d07a8e311c1a8174b3604eaa508f93074210ba17d49b3f7f6ebc86",
  "7eee89dd7a91770a9e973ba3ead68b673db35237ef299c04007c57263fabd121",
  "8c3666d72b4da0ff3a3f70945e17a37313603be732df7bb63d765f9bbdb1ccf3",
  "a957b66adc402d20d4db8dcbaecf89c0798bb5eb87019b3e7bac44502fa963be",
  "ba06398ce4a9de96b23bd0bde76548b81f0468108fb3c36e21afa9954f365e54",
  "c5f2688b2ea4e13129931a8eca51a1c50649777cedabe7c0ec3308cf97a7a86c",
  "e6693e018475e1f4d87badde3a3d6dc9b3d820c42144576da5b404e4d1178fa2",
]);
const encoder = new TextEncoder();

export async function visibleInStagingHome<T extends { readonly id: string; readonly name: string }>(
  apps: readonly T[],
  origin = globalThis.location?.origin,
): Promise<readonly T[]> {
  if (origin !== stagingOrigin || !globalThis.crypto?.subtle) return apps;
  const visibility = await Promise.all(apps.map(async ({ id, name }) => {
    try {
      const input = encoder.encode(JSON.stringify([id, name]));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
      const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return !hidden.has(fingerprint);
    } catch {
      return true;
    }
  }));
  return apps.filter((_, index) => visibility[index]);
}
