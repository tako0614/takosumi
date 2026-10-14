-- Migration: 20261014000071_scheduled_sweep_cursors
create table if not exists takosumi_scheduled_sweep_cursors (
  lane text primary key check (lane in ('workspaces', 'active_capsules', 'recoverable_runs')),
  generation bigint not null default 0,
  cursor_created_at text,
  cursor_id text,
  upper_created_at text,
  upper_id text,
  check ((cursor_created_at is null) = (cursor_id is null)),
  check ((upper_created_at is null) = (upper_id is null))
);
insert into takosumi_scheduled_sweep_cursors (lane, generation)
values ('workspaces', 0), ('active_capsules', 0), ('recoverable_runs', 0)
on conflict (lane) do nothing;
