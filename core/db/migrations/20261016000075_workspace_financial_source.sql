-- Migration: 20261016000075_workspace_financial_source
-- Additive protected-data migration; Postgres catalog v121 / Control D1 v75.
-- Explicit original enrollment only. Retained custody has no ephemeral FK/cascade.
create table takosumi_workspace_financial_sources (
 workspace_id text primary key, source_ref text not null, incarnation text not null,
 registration_json text not null, enrollment_json text not null, identity_json text not null,
 permission_sequence bigint not null default 0 check(permission_sequence between 0 and 9007199254740991),
 last_event_ref text, management_state text not null, closed integer not null default 0 check(closed in (0,1)),
 materialized_sequence bigint not null default 0 check(materialized_sequence between 0 and permission_sequence),
 materialized_digest text not null, enrolled_at text not null
);
create unique index takosumi_workspace_financial_sources_source_ref_unique on takosumi_workspace_financial_sources(source_ref);
create table takosumi_workspace_financial_events (
 event_ref text primary key, workspace_id text not null, source_ref text not null, incarnation text not null,
 sequence bigint not null check(sequence between 1 and 9007199254740991), previous_event_ref text,
 kind text not null, payload_json text not null, closed integer not null check(closed in (0,1)), recorded_at text not null
);
create unique index takosumi_workspace_financial_events_workspace_sequence_unique on takosumi_workspace_financial_events(workspace_id,sequence);
create table takosumi_workspace_financial_materializations (
 event_ref text primary key, source_ref text not null, incarnation text not null, sequence bigint not null,
 previous_digest text not null, digest text not null, expected_head_json text not null, record_json text not null
);
create table takosumi_workspace_financial_receipts (
 event_ref text not null, receiver_ref text not null, target_ref text not null, record_json text not null,
 primary key(event_ref,receiver_ref)
);
create function takosumi_financial_source_head_guard() returns trigger language plpgsql as $financial$
begin
 if TG_OP='DELETE' then raise exception 'Financial source tombstone is retained'; end if;
 if NEW.workspace_id is distinct from OLD.workspace_id or NEW.source_ref is distinct from OLD.source_ref or NEW.incarnation is distinct from OLD.incarnation
 or NEW.registration_json is distinct from OLD.registration_json or NEW.enrollment_json is distinct from OLD.enrollment_json or NEW.identity_json is distinct from OLD.identity_json or NEW.enrolled_at is distinct from OLD.enrolled_at
 or OLD.closed=1 and NEW.closed<>1 then raise exception 'Immutable financial source identity'; end if;
 if NEW.permission_sequence<>OLD.permission_sequence then
  if NEW.permission_sequence<>OLD.permission_sequence+1 or NEW.materialized_sequence<>OLD.materialized_sequence or NEW.materialized_digest<>OLD.materialized_digest
  or not exists(select 1 from takosumi_workspace_financial_events e where e.event_ref=NEW.last_event_ref and e.workspace_id=OLD.workspace_id
    and e.sequence=NEW.permission_sequence and e.source_ref=OLD.source_ref and e.incarnation=OLD.incarnation and e.previous_event_ref is not distinct from OLD.last_event_ref and e.closed=NEW.closed)
  then raise exception 'Noncontiguous financial source event'; end if;
 elsif NEW.last_event_ref is distinct from OLD.last_event_ref or NEW.closed<>OLD.closed or NEW.management_state<>OLD.management_state then raise exception 'Financial source mutation needs raw event'; end if;
 if NEW.materialized_sequence<>OLD.materialized_sequence then
  if NEW.materialized_sequence<>OLD.materialized_sequence+1 or NEW.permission_sequence<>OLD.permission_sequence
  or not exists(select 1 from takosumi_workspace_financial_materializations m join takosumi_workspace_financial_events e on e.event_ref=m.event_ref
    where e.workspace_id=OLD.workspace_id and m.sequence=NEW.materialized_sequence and m.digest=NEW.materialized_digest and m.previous_digest=OLD.materialized_digest)
  then raise exception 'Noncontiguous financial materialization'; end if;
 elsif NEW.materialized_digest<>OLD.materialized_digest then raise exception 'Financial digest rewrite refused'; end if;
 return NEW;
end
$financial$;
create trigger takosumi_workspace_financial_sources_guard before update or delete on takosumi_workspace_financial_sources for each row execute function takosumi_financial_source_head_guard();
create function takosumi_financial_source_immutable() returns trigger language plpgsql as $financial$
begin raise exception 'Immutable financial source custody'; end
$financial$;
create trigger takosumi_workspace_financial_events_immutable before update or delete on takosumi_workspace_financial_events for each row execute function takosumi_financial_source_immutable();
create trigger takosumi_workspace_financial_materializations_immutable before update or delete on takosumi_workspace_financial_materializations for each row execute function takosumi_financial_source_immutable();
create trigger takosumi_workspace_financial_receipts_immutable before update or delete on takosumi_workspace_financial_receipts for each row execute function takosumi_financial_source_immutable();
create function takosumi_financial_source_materialize() returns trigger language plpgsql as $financial$
begin
 perform 1 from takosumi_workspace_financial_sources where workspace_id=(select workspace_id from takosumi_workspace_financial_events where event_ref=NEW.event_ref) for update;
 if not exists(select 1 from takosumi_workspace_financial_events e join takosumi_workspace_financial_sources h on h.workspace_id=e.workspace_id
 where e.event_ref=NEW.event_ref and e.source_ref=NEW.source_ref and e.incarnation=NEW.incarnation and e.sequence=NEW.sequence
 and h.materialized_sequence=NEW.sequence-1 and h.materialized_digest=NEW.previous_digest
 and h.permission_sequence=(NEW.expected_head_json::jsonb ->> 'permissionSequence')::bigint
 and h.closed=case when (NEW.expected_head_json::jsonb ->> 'closed')::boolean then 1 else 0 end
 and h.last_event_ref is not distinct from (NEW.expected_head_json::jsonb ->> 'lastEventRef')
 and h.management_state=NEW.expected_head_json::jsonb ->> 'managementState'
 and (NEW.sequence=1 and e.previous_event_ref is null or exists(select 1 from takosumi_workspace_financial_materializations prior
 where prior.event_ref=e.previous_event_ref and prior.sequence=NEW.sequence-1 and prior.source_ref=NEW.source_ref and prior.incarnation=NEW.incarnation and prior.digest=NEW.previous_digest))) then raise exception 'Financial materialization predecessor conflict'; end if;
 update takosumi_workspace_financial_sources set materialized_sequence=NEW.sequence,materialized_digest=NEW.digest where workspace_id=(select workspace_id from takosumi_workspace_financial_events where event_ref=NEW.event_ref);
 return NEW;
end
$financial$;
create trigger takosumi_workspace_financial_materializations_progress after insert on takosumi_workspace_financial_materializations for each row execute function takosumi_financial_source_materialize();
create function takosumi_financial_source_mutation() returns trigger language plpgsql as $financial$
declare wid text; source takosumi_workspace_financial_sources%rowtype; cause text; prior text; nextrow text; terminal integer; nextstate text;
begin
 if TG_TABLE_NAME='takosumi_workspace_members' then
  if TG_OP='DELETE' then wid:=OLD.workspace_id; else wid:=NEW.workspace_id; end if;
  if TG_OP='UPDATE' and NEW.workspace_id is distinct from OLD.workspace_id and exists(select 1 from takosumi_workspace_financial_sources where workspace_id in (OLD.workspace_id,NEW.workspace_id)) then raise exception 'Financial member identity relocation refused'; end if;
 else
  if TG_OP='UPDATE' and NEW.id is distinct from OLD.id and exists(select 1 from takosumi_workspace_financial_sources where workspace_id in (OLD.id,NEW.id)) then raise exception 'Financial Workspace identity relocation refused'; end if;
  if TG_OP='DELETE' then wid:=OLD.id; else wid:=NEW.id; end if;
 end if;
 select * into source from takosumi_workspace_financial_sources where workspace_id=wid for update;
 if not found then if TG_OP='DELETE' then return OLD; else return NEW; end if; end if;
 if source.closed=1 then
  if TG_TABLE_NAME='takosumi_workspace_members' and TG_OP='DELETE' then return OLD; end if;
  raise exception 'Financial source is permanently closed';
 end if;
 if TG_OP='INSERT' and TG_TABLE_NAME='takosumi_workspaces' then raise exception 'Financial source incarnation cannot reopen'; end if;
 if TG_OP='UPDATE' and to_jsonb(OLD)=to_jsonb(NEW) then return NEW; end if;
 if TG_OP='INSERT' then prior:='null'; else prior:=to_jsonb(OLD)::text; end if;
 if TG_OP='DELETE' then nextrow:='null'; else nextrow:=to_jsonb(NEW)::text; end if;
 terminal:=case when TG_TABLE_NAME='takosumi_workspaces' and TG_OP='DELETE' then 1 else 0 end;
 cause:=case when TG_TABLE_NAME='takosumi_workspace_members' then 'member-' || lower(TG_OP) when TG_OP='DELETE' then 'workspace-delete'
  when TG_OP='UPDATE' and (to_jsonb(NEW)->>'management_state' is distinct from to_jsonb(OLD)->>'management_state' or to_jsonb(NEW)->>'management_epoch' is distinct from to_jsonb(OLD)->>'management_epoch') then 'management-update' else 'workspace-update' end;
 nextstate:=source.management_state;
 if TG_TABLE_NAME='takosumi_workspaces' and TG_OP<>'DELETE' then nextstate:=to_jsonb(NEW)->>'management_state'; end if;
 insert into takosumi_workspace_financial_events(event_ref,workspace_id,source_ref,incarnation,sequence,previous_event_ref,kind,payload_json,closed,recorded_at)
 values(source.source_ref || '/event/' || (source.permission_sequence+1),wid,source.source_ref,source.incarnation,source.permission_sequence+1,source.last_event_ref,cause,
 jsonb_build_object('before',prior::jsonb,'after',nextrow::jsonb)::text,terminal,clock_timestamp()::text);
 update takosumi_workspace_financial_sources set permission_sequence=source.permission_sequence+1,last_event_ref=source.source_ref || '/event/' || (source.permission_sequence+1),closed=terminal,management_state=nextstate where workspace_id=wid;
 if TG_OP='DELETE' then return OLD; else return NEW; end if;
end
$financial$;
create trigger takosumi_workspaces_financial_source before update or delete on takosumi_workspaces for each row execute function takosumi_financial_source_mutation();
create trigger takosumi_workspaces_financial_source_insert after insert on takosumi_workspaces for each row execute function takosumi_financial_source_mutation();
create trigger takosumi_workspace_members_financial_source before update or delete on takosumi_workspace_members for each row execute function takosumi_financial_source_mutation();
create trigger takosumi_workspace_members_financial_source_insert after insert on takosumi_workspace_members for each row execute function takosumi_financial_source_mutation();
create function takosumi_financial_binding_immutable() returns trigger language plpgsql as $financial$
begin if exists(select 1 from takosumi_workspace_financial_sources where workspace_id=OLD.workspace_id) then raise exception 'Enrolled financial binding is immutable'; end if;
if TG_OP='DELETE' then return OLD; else return NEW; end if; end
$financial$;
create trigger takosumi_workspace_billing_bindings_financial_source before update or delete on takosumi_workspace_billing_bindings for each row execute function takosumi_financial_binding_immutable();
