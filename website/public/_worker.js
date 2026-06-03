const TOMBSTONED_PREFIXES = [
  "/kinds/",
  "/docs/kinds/",
  "/docs/accounts/",
  "/docs/operator/",
];

const TOMBSTONED_REFERENCE_PREFIXES = [
  "/docs/reference/catalog",
  "/docs/reference/kind-",
  "/docs/reference/build-spec",
  "/docs/reference/platform-services",
  "/docs/reference/takosumi-v1",
  "/docs/reference/spec-boundaries",
  "/docs/reference/public-spec-source-map",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isTombstoned(url.pathname)) {
      return new Response("Not found\n", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
};

function isTombstoned(pathname) {
  return TOMBSTONED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    TOMBSTONED_REFERENCE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
