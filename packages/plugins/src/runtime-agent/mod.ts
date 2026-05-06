/**
 * Reference remote runtime-agent (Phase 17B).
 *
 * Lightweight Deno HTTP client that enrolls with a Takosumi kernel, pulls
 * work leases, dispatches them to provider plugin executors, and reports the
 * outcome back. The agent process itself is meant to be deployed inside the
 * operator-owned tenant cloud (AWS EC2 / GCP Compute / k8s pod / etc.).
 */
export * from "./client.ts";
export * from "./loop.ts";
export * from "./handoff.ts";
export * from "./tracing.ts";
