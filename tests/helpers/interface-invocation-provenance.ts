import type { TokenRecord } from "../../accounts/service/src/store.ts";
import { sha256Text } from "../../accounts/service/src/encoding.ts";

/** Persistence projection fixture only; never an authenticated producer proof. */
export async function syntheticInvocationRecord(): Promise<TokenRecord> {
  const now = Date.now();
  return { clientId: "https://office.example.test/mcp", audience: "https://office.example.test/mcp",
    scope: "mcp.invoke", subject: "pairwise_agent_person",
    capsuleId: "office", workspaceId: "internal_partition", role: "interface-runtime-source-v1",
    interfaceId: "if_office", interfaceBindingId: "ifb_person", interfaceResolvedRevision: 1, expiresAt: now + 30_000,
    invocationSource: { source: { version: "takosumi.interface-invocation-source/v1", kind: "oauth-access-token",
      tokenHash: await sha256Text("synthetic_parent_only"), accountSubject: "tsub_person", subjectId: "pairwise_agent_person",
      clientId: "agent-client", capsuleId: "agent", scope: "openid capsules:read", expiresAt: now + 60_000,
      activationDigest: "synthetic_activation" }, interfaceGeneration: 1, bindingGeneration: 1,
      link: { id: "agent-office-link", generation: 1 } } };
}
