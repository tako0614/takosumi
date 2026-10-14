import { expect, test } from "bun:test";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { createWorkspaceBillingBootstrapResolver, type WorkspaceBillingEnrollmentPort } from "../../../../accounts/service/src/workspace-billing-bootstrap.ts";
import type { WorkspaceBillingBindingIntent } from "takosumi-contract";

const accountId = "tsub_billing_owner" as const;
const viewerId = "tsub_billing_viewer" as const;
const billingAuthority = "reviewed-stage-billing-owner";

async function fixture(enroll?: WorkspaceBillingEnrollmentPort["ensureOrganization"]) {
  const store = new InMemoryOpenTofuControlStore();
  const service = new WorkspacesService({store});
  const workspace = await service.createWorkspace({handle:"billing-workspace",displayName:"Billing",type:"organization",ownerUserId:accountId});
  const operations = {workspaces:{billingBindings:service.billingBindings},members:{getMember:store.getWorkspaceMember.bind(store)}} as Pick<ControlPlaneOperations,"workspaces"|"members">;
  const resolver = createWorkspaceBillingBootstrapResolver({operations,billingAuthority,...(enroll?{enrollment:{ensureOrganization:enroll}}:{})});
  const input = {workspaceId:workspace.id,canonicalAccountId:accountId,assertCurrentGrant:async()=>true};
  return {store,service,workspace,operations,resolver,input};
}

const acknowledgement = (intent: WorkspaceBillingBindingIntent) => ({intentId:intent.intentId,workspaceId:intent.workspaceId,billingAuthority:intent.billingAuthority,workspaceRef:intent.workspaceRef,organizationRef:"org_preserved",ownerAcknowledgementRef:"reviewed_owner_ack"});

test("actual Control intent precedes enrollment and one retained primary binding survives concurrent RP bootstrap",async()=>{
  let f: Awaited<ReturnType<typeof fixture>>;
  const seen: WorkspaceBillingBindingIntent[]=[];
  f=await fixture(async(intent)=>{
    expect((await f.service.billingBindings.get(intent.workspaceId)).intent?.intentId).toBe(intent.intentId);
    expect(Object.keys(intent).sort()).toEqual(["actorAccountId","billingAuthority","createdAt","intentId","managementEpoch","workspaceCreatedAt","workspaceId","workspaceRef"].sort());
    seen.push(intent); return acknowledgement(intent);
  });
  const result=await Promise.all([f.resolver(f.input),f.resolver(f.input)]);
  expect(result[0]).toEqual(result[1]);
  expect(result[0]).toMatchObject({workspaceId:f.workspace.id,organizationId:"org_preserved"});
  expect(new Set(seen.map(i=>i.intentId)).size).toBe(1);
  expect(new Set(seen.map(i=>i.workspaceRef)).size).toBe(1);
  const binding=(await f.service.billingBindings.get(f.workspace.id)).binding!;
  expect(binding.organizationRef).toBe("org_preserved");
  const again=await f.resolver(f.input);expect(again).toEqual(result[0]);expect(seen).toHaveLength(2);
});

test("unknown owner acknowledgement retains the same original intent/ref without inventing a second Organization",async()=>{
  const seen: WorkspaceBillingBindingIntent[]=[];
  const f=await fixture(async(intent)=>{seen.push(intent);return seen.length===1?null:acknowledgement(intent);});
  expect(await f.resolver(f.input)).toBeNull();
  expect((await f.service.billingBindings.get(f.workspace.id)).binding).toBeUndefined();
  expect(await f.resolver(f.input)).toMatchObject({organizationId:"org_preserved"});
  expect(seen[0]).toEqual(seen[1]);
});

test("missing real owner never prepares enrollment; existing immutable binding remains readable",async()=>{
  const f=await fixture();
  expect(await f.resolver(f.input)).toBeNull();
  expect(await f.service.billingBindings.get(f.workspace.id)).toEqual({});
  const intent=await f.service.billingBindings.prepare({workspaceId:f.workspace.id,billingAuthority,actorAccountId:accountId});
  await f.service.billingBindings.claim({workspaceId:f.workspace.id,intentId:intent.intentId,actorAccountId:accountId,organizationRef:"org_historical",ownerAcknowledgementRef:"reviewed_import"});
  expect(await f.resolver(f.input)).toEqual({workspaceId:f.workspace.id,workspaceRef:intent.workspaceRef,organizationId:"org_historical"});
});

test("viewer can read an existing retained binding but cannot initiate missing enrollment",async()=>{
  let calls=0;const f=await fixture(async(intent)=>{calls++;return acknowledgement(intent);});
  await f.store.putWorkspaceMember({workspaceId:f.workspace.id,accountId:viewerId,status:"active",roles:["viewer"],createdAt:f.workspace.createdAt,updatedAt:f.workspace.updatedAt});
  await expect(f.resolver({...f.input,canonicalAccountId:viewerId})).rejects.toMatchObject({status:503});expect(calls).toBe(0);
  const bound=await f.resolver(f.input);
  expect(await f.resolver({...f.input,canonicalAccountId:viewerId})).toEqual(bound);expect(calls).toBe(1);
});

test("current grant revocation after owner await rejects before Control claim",async()=>{
  let current=true;const f=await fixture(async(intent)=>{current=false;return acknowledgement(intent);});
  await expect(f.resolver({...f.input,assertCurrentGrant:async()=>current})).rejects.toMatchObject({status:401});
  expect((await f.service.billingBindings.get(f.workspace.id)).binding).toBeUndefined();
  expect((await f.service.billingBindings.get(f.workspace.id)).intent).toBeDefined();
});

test("original membership revocation during external enrollment refuses atomic claim and preserves original intent",async()=>{
  let f: Awaited<ReturnType<typeof fixture>>;
  f=await fixture(async(intent)=>{const member=await f.store.getWorkspaceMember(intent.workspaceId,accountId);await f.store.putWorkspaceMember({...member!,status:"suspended"});return acknowledgement(intent);});
  await expect(f.resolver(f.input)).rejects.toMatchObject({status:503});
  const state=await f.service.billingBindings.get(f.workspace.id);expect(state.binding).toBeUndefined();expect(state.intent?.actorAccountId).toBe(accountId);
  expect((await f.store.getWorkspaceMember(f.workspace.id,accountId))?.status).toBe("suspended");
});

test("mismatched owner references and retained financial authority fail closed",async()=>{
  const f=await fixture(async(intent)=>({...acknowledgement(intent),workspaceRef:"different_protected_reference"}));
  await expect(f.resolver(f.input)).rejects.toMatchObject({status:503});
  expect((await f.service.billingBindings.get(f.workspace.id)).binding).toBeUndefined();
  const other=createWorkspaceBillingBootstrapResolver({operations:f.operations,billingAuthority:"different-owner",enrollment:{ensureOrganization:async(intent)=>acknowledgement(intent)}});
  await expect(other(f.input)).rejects.toMatchObject({status:503});
});
