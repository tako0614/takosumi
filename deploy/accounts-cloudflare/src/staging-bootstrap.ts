/** Inert slot for the topology lane: no issuer, store, cookie, or secret access. */
export default {
  fetch(): Response {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  },
};
