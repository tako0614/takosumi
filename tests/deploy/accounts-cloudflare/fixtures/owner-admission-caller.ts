import { WorkerEntrypoint } from "cloudflare:workers";

/** Test-only private RPC caller. Its HTTP handler cannot forward capabilities. */
export default class FixtureHostedOwner extends WorkerEntrypoint {
  async readOwnerOperation(input: unknown) {
    return this.env.PRIVATE_ACCOUNTS.readOwnerOperation(input);
  }
  fetch() { return new Response("not_found", { status: 404 }); }
}
