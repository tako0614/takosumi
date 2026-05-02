-- Migration: 20260430000019_replay_protection_log
-- Purpose:   Provide a durable, cross-process / cross-pod source of truth for
--            observed signed internal RPC request-ids so multiple PaaS
--            replicas (k8s pods, Cloudflare Worker isolates, multiple Deno
--            hosts behind a load balancer) cannot each independently accept
--            the same replayed request.
--
--            The in-memory `seenRequestIds` Map (5s TTL) only protected a single
--            process; under a multi-replica deploy a previously-seen
--            request-id could be replayed against a sibling process that
--            had not yet observed it. This table is the durable backend for
--            `SqlReplayProtectionStore`, which uses an `INSERT ... ON
--            CONFLICT DO NOTHING` to claim the (namespace, request_id)
--            tuple atomically.
--
-- Spec:      /docs/takos-paas/core/01-core-contract-v1.0.md (signed internal RPC)
-- Phase:     18.3 (M4 distributed replay protection)
-- Domain:    internal-auth / replay-protection

create table if not exists internal_request_replay_log (
  -- Logical namespace (`internal-request` for inbound signed RPC,
  -- `internal-response` for kernel-side response signatures). Keeping
  -- request and response signatures in distinct namespaces prevents a
  -- request signature from masking a later response signature with the
  -- same id.
  namespace      text   not null
    check (namespace in ('internal-request','internal-response')),
  -- The signed `x-takos-internal-request-id` value. Together with
  -- `namespace` this forms the conflict key the verifier races against.
  request_id     text   not null,
  -- Wall-clock millisecond timestamp at which the signature was issued
  -- (parsed from the `x-takos-internal-timestamp` header). Stored for
  -- diagnostics and to bound `cleanupExpired` queries.
  timestamp_ms   bigint not null,
  -- Wall-clock millisecond expiry — once the row is older than this the
  -- background cleanup job evicts it. Matches the signed-request TTL
  -- (typically `TAKOS_INTERNAL_SIGNATURE_MAX_SKEW_MS`).
  expires_at_ms  bigint not null,
  -- Wall-clock millisecond timestamp at which this verifier observed the
  -- signature. Useful for forensic correlation across replicas.
  seen_at_ms     bigint not null,
  primary key (namespace, request_id)
);

-- The cleanup job (`SqlReplayProtectionStore.cleanupExpired`) deletes
-- rows where `expires_at_ms <= now`. An index on the expiry column keeps
-- that scan bounded as the table grows.
create index if not exists internal_request_replay_log_expires_idx
  on internal_request_replay_log (expires_at_ms);
