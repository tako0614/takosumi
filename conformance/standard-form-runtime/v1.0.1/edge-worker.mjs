const RESPONSE_BODY = "takoform-standard-edge-worker-v1.0.1\n";

export default {
  async fetch() {
    return new Response(RESPONSE_BODY, {
      headers: {
        "cache-control": "public, max-age=60",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  },
};
