-- Migration: 20260430000020_takosumi_deployments
-- Purpose:   Persist takosumi public deploy state so that
--            POST /v1/deployments (mode=apply) and POST /v1/deployments
--            (mode=destroy) form an end-to-end lifecycle:
--              - apply persists the submitted manifest and the per-resource
--                handles returned by `provider.apply`
--              - destroy looks the row up by (tenant_id, name) and feeds the
--                persisted handles into `destroyV2.handleFor` so providers see
--                the real ARN / object id rather than the resource name
--              - GET /v1/deployments and GET /v1/deployments/:name surface the
--                stored state to `takosumi status`
--
--            Distinct from the internal `deployments` table (kernel core
--            DeploymentService): this table tracks the public-deploy CLI
--            lifecycle, not the internal control-plane Deployment graph.
--
-- Spec:      packages/kernel/src/api/deploy_public_routes.ts
-- Phase:     takosumi public deploy state persistence
-- Domain:    deploy

create table if not exists takosumi_deployments (
  -- Surrogate uuid key. The (tenant_id, name) tuple is the natural key but a
  -- separate id keeps re-applies cheap (existing row updated in place).
  id                 text        primary key,
  -- Tenant scope. The public deploy route uses a single token so today the
  -- value is constant ("takosumi-deploy") but the column is reserved for
  -- multi-tenant routing if the route ever grows past shared-secret auth.
  tenant_id          text        not null,
  -- Deployment name from `manifest.metadata.name` (or a fallback hash when
  -- the manifest does not carry one). Forms part of the natural key.
  name               text        not null,
  -- Full submitted manifest (resources[] or expanded template result).
  -- Stored verbatim so a future re-apply or audit trace can replay the
  -- caller's exact submission.
  manifest_json      jsonb       not null,
  -- Array of `{ resourceName, shape, providerId, handle, outputs, appliedAt }`
  -- entries derived from `applyV2` outcome. `handle` is the value
  -- destroy needs to feed back to `provider.destroy`.
  applied_resources_json jsonb   not null default '[]'::jsonb,
  -- Lifecycle status of the most recent apply / destroy attempt.
  status             text        not null
    check (status in ('applied','destroyed','failed')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists takosumi_deployments_tenant_idx
  on takosumi_deployments (tenant_id);
create index if not exists takosumi_deployments_status_idx
  on takosumi_deployments (status);
