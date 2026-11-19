import { createEphemeralAccountsHandler } from "../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";

const issuer = "http://localhost";
const subject = "tsub_worker_password_fixture";
let initialized: ReturnType<typeof createEphemeralAccountsHandler> | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    if (!initialized) {
      const store = new InMemoryAccountsStore();
      const now = Date.now();
      store.saveAccount({
        subject, email: "worker-fixture@example.test", emailVerified: true, createdAt: now, updatedAt: now,
      });
      store.linkUpstreamIdentity({
        providerId: "google", upstreamIssuer: "https://accounts.google.com", upstreamSubject: "fixture",
        subject, createdAt: now, updatedAt: now,
      });
      store.saveAccountSession({ sessionId: "sess_worker_fixture", subject, createdAt: now, expiresAt: now + 60_000 });
      initialized = createEphemeralAccountsHandler({ issuer, store, passwordAuthMode: "login" });
    }
    return (await initialized)(request);
  },
};
