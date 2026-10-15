import type { SqlClient, SqlTransaction } from "../../../../core/adapters/storage/sql.ts";
import { IdentityReconciliationService } from "../../../../core/domains/identity-reconciliation/mod.ts";
import type { ControlMergeAdmission, ControlIdentityAuthorityReader } from "../../../../contract/identity-reconciliation.ts";
import { InMemoryInterfaceBindingStore, InMemoryInterfaceStore } from "../../../../core/domains/interfaces/stores.ts";
import { createSqlInterfaceStores } from "../../../../core/domains/interfaces/sql_stores.ts";
import { createD1InterfaceStores } from "../../../../core/domains/interfaces/d1_stores.ts";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import {
  workerdD1Database,
  workerdD1Module,
} from "../../../helpers/deploy-control/workerd_d1.ts";

async function adapters() {
  const postgres = await PGliteSqlClient.create();
  const runtime = new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [workerdD1Module("workspace-financial-source-native.mjs")],
    d1Databases: { CONTROL: "workspace-financial-source-native" },
  });
  await runtime.ready;
  const native = workerdD1Database(runtime);
  const memory = new InMemoryOpenTofuControlStore();
  memory.attachIdentityReconciliationPrincipalStore(new InMemoryInterfaceBindingStore(new InMemoryInterfaceStore()));
  createSqlInterfaceStores(postgres);
  createD1InterfaceStores(native);
  const rows: readonly { label: string; store: OpenTofuControlStore }[] = [
    { label: "memory", store: memory },
    { label: "postgres", store: new SqlOpenTofuControlStore({ client: postgres }) },
    { label: "native-d1", store: new CloudflareD1OpenTofuControlStore(native) },
  ];
  return { rows, native, postgres, close: async () => {
    await runtime.dispose();
    await postgres.close();
  } };
}

function service(store: OpenTofuControlStore, prefix: string) {
  let id = 0;
  return new WorkspacesService({
    store,
    newId: (kind) => `${kind}_${prefix}_${++id}`,
    now: () => new Date("2026-10-15T00:00:00.000Z"),
  });
}

test("enrolled actual member mutation advances its independent financial permission source and invalidates the original snapshot", async () => {
  const f = await adapters();
  try {
    for (const { label, store } of f.rows) {
      const owner = service(store, label);
      const workspace = await owner.ensurePersonalWorkspaceForSharedAccount("actor_original", `financial-${label}`);
      const intent = await owner.billingBindings.prepare({
        workspaceId: workspace.id, billingAuthority: "financial-fixture",
        actorAccountId: "actor_original",
      });
      await owner.billingBindings.claim({
        workspaceId: workspace.id, intentId: intent.intentId,
        actorAccountId: "actor_original", organizationRef: `org_${label}`,
        ownerAcknowledgementRef: "synthetic_existing_owner_ack",
      });
      await store.putWorkspaceMember({
        id: `member_${label}`, workspaceId: workspace.id, accountId: "actor_member",
        status: "active", roles: ["viewer"], createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      });
      const original = await owner.financialSource.prepareEnrollment({ workspaceId: workspace.id });
      if(!original)throw new Error("Missing actual enrollment census");
      await owner.financialSource.enroll({ original, registration: {
        sourceRef: `control_${label}`, incarnation: `original_${label}`,
        genesisDigest: "a".repeat(64), requiredReceivers: [{receiverRef:"financial_fixture",targetRef:"actual_fixture_target"}],
      } });
      const snapshot = await owner.financialSource.captureFinancialSourceSnapshot({
        workspaceId: workspace.id, actorAccountId: "actor_original",
      });
      expect(snapshot?.head.permissionSequence, label).toBe(0);
      const beforeManagement = await store.getWorkspaceManagement(workspace.id);
      await owner.upsertWorkspaceMember({
        workspaceId: workspace.id, accountId: "actor_member",
        actorAccountId: "actor_original", status: "suspended",
        requireCurrentMembership: true,
      });
      const head = await owner.financialSource.readHead(workspace.id);
      expect(head?.permissionSequence, label).toBe(1);
      expect(await store.getWorkspaceManagement(workspace.id), label).toEqual(beforeManagement);
      expect(await owner.financialSource.assertFinancialSourceSnapshotCurrent(snapshot!), label).toBe(false);
      const events = await owner.financialSource.listRawEvents({ workspaceId: workspace.id, afterSequence: 0, limit: 10 });
      expect(events, label).toHaveLength(1);
      expect(events[0], label).toMatchObject({ permissionSequence: 1, previousEventRef: null, kind: "member-update" });
    }
  } finally { await f.close(); }
}, 30_000);

async function enrolled(store:OpenTofuControlStore,label:string,actor="actor_original",override:Partial<import("../../../../core/domains/workspaces/financial-source.ts").WorkspaceFinancialRegistration>={}){
  const owner=service(store,label),workspace=await owner.ensurePersonalWorkspaceForSharedAccount(actor,`cfs-${label}`);
  const intent=await owner.billingBindings.prepare({workspaceId:workspace.id,billingAuthority:"local_source_fixture",actorAccountId:actor});
  await owner.billingBindings.claim({workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:actor,organizationRef:`org_${label}`,ownerAcknowledgementRef:`existing_ack_${label}`});
  const original=await owner.financialSource.prepareEnrollment({workspaceId:workspace.id});
  if(!original)throw new Error("Missing actual original enrollment census");
  const registration={sourceRef:`control_${label}`,incarnation:`inc_${label}`,genesisDigest:"a".repeat(64),requiredReceivers:[
    {receiverRef:"financial_one",targetRef:"actual_target_one"},{receiverRef:"financial_two",targetRef:"actual_target_two"},
  ],...override};
  const head=await owner.financialSource.enroll({original,registration});
  if(!head)throw new Error("Original source enrollment refused");
  return{owner,workspace,original,registration,head};
}

/** Genuine SHA over opaque fixture bytes exercises Core custody only. The
 * Accounts codec and real Financial receiver/grants have independent owners. */
async function materialization(store:OpenTofuControlStore,event:import("../../../../core/domains/workspaces/financial-source.ts").WorkspaceFinancialRawEvent){
  const head=await store.getWorkspaceFinancialSourceHead(event.workspaceId);
  if(!head)throw new Error("Missing original source head");
  const wireJson=JSON.stringify({fixture:"Core-local-opaque-materialization",event});
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(wireJson))),n=>n.toString(16).padStart(2,"0")).join("");
  return{original:event,expectedHead:head,materialization:{eventRef:event.eventRef,sourceRef:event.sourceRef,incarnation:event.incarnation,
    permissionSequence:event.permissionSequence,rawPayloadJson:event.payloadJson,previousDigest:head.materializedDigest,wireJson,digest}};
}
function receipt(input:Awaited<ReturnType<typeof materialization>>,receiverRef:string,targetRef:string){
  const m=input.materialization;
  return{eventRef:m.eventRef,sourceRef:m.sourceRef,incarnation:m.incarnation,permissionSequence:m.permissionSequence,
    receiverRef,targetRef,digest:m.digest,receiptRef:`retained_receipt_${receiverRef}_${m.permissionSequence}`,
    receiptJson:JSON.stringify({fixture:"actual-local-validated-receipt-port",eventRef:m.eventRef,digest:m.digest})};
}

test("full raw/head CAS, ordered materialization, immutable unknown-ACK recovery and complete original receiver-target custody",async()=>{
  const f=await adapters();try{for(const{label,store}of f.rows){
    const c=await enrolled(store,`custody_${label}`);
    const actor=(await store.getWorkspaceMember(c.workspace.id,"actor_original"))!;
    await store.putWorkspaceMember({...actor,roles:["owner","admin"]});
    const e1=(await c.owner.financialSource.listRawEvents({workspaceId:c.workspace.id,afterSequence:0,limit:64}))[0]!;
    const m1=await materialization(store,e1);
    expect(await c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"}),label).toBeUndefined();
    expect(await store.materializeWorkspaceFinancialEvent({...m1,original:{...e1,payloadJson:e1.payloadJson+" "}}),label).toBe(false);
    expect(await store.materializeWorkspaceFinancialEvent({...m1,expectedHead:{...m1.expectedHead,organizationRef:"replacement_org"}}),label).toBe(false);
    expect(await store.materializeWorkspaceFinancialEvent(m1),label).toBe(true);
    expect(await store.materializeWorkspaceFinancialEvent(m1),label).toBe(true); // lost ACK exact replay
    expect(await store.materializeWorkspaceFinancialEvent({...m1,materialization:{...m1.materialization,wireJson:"different"}}),label).toBe(false);
    const r1=receipt(m1,"financial_one","actual_target_one"),r2=receipt(m1,"financial_two","actual_target_two");
    expect(await store.recordWorkspaceFinancialReceipt({...r1,targetRef:"replacement_target"}),label).toBe(false);
    expect(await store.recordWorkspaceFinancialReceipt(r1),label).toBe(true);
    expect(await c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"}),label).toBeUndefined();
    expect(await store.recordWorkspaceFinancialReceipt(r2),label).toBe(true);
    expect(await store.recordWorkspaceFinancialReceipt(r1),label).toBe(true);
    expect(await store.recordWorkspaceFinancialReceipt({...r1,receiptRef:"replacement_receipt"}),label).toBe(false);
    expect((await c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"}))?.head.permissionSequence,label).toBe(1);
    expect(await store.listWorkspaceFinancialPendingEvents({workspaceId:c.workspace.id,receiverRef:"financial_one",afterSequence:0,limit:64}),label).toEqual([]);
    // Async upper codec work must retain its captured head. A second mutation
    // makes the captured event2/head2 stale before publication of event2.
    await store.putWorkspaceMember({...actor,roles:["owner","viewer"]});
    const e2=(await store.listWorkspaceFinancialRawEvents({workspaceId:c.workspace.id,afterSequence:1,limit:64}))[0]!;
    const stale=await materialization(store,e2);
    await store.putWorkspaceMember({...actor,roles:["owner","admin","viewer"]});
    const e3=(await store.listWorkspaceFinancialRawEvents({workspaceId:c.workspace.id,afterSequence:2,limit:64}))[0]!;
    expect(await store.materializeWorkspaceFinancialEvent(stale),label).toBe(false);
    expect(await store.materializeWorkspaceFinancialEvent(await materialization(store,e3)),label).toBe(false); // no gap
    const m2=await materialization(store,e2);
    expect(await store.materializeWorkspaceFinancialEvent(m2),label).toBe(true);
    const m3=await materialization(store,e3);
    expect(await store.materializeWorkspaceFinancialEvent(m3),label).toBe(true);
    expect(await store.recordWorkspaceFinancialReceipt(receipt(m3,"financial_one","actual_target_one")),label).toBe(false); // ACK gap
    for(const m of[m2,m3])for(const [receiver,target]of[["financial_one","actual_target_one"],["financial_two","actual_target_two"]])
      expect(await store.recordWorkspaceFinancialReceipt(receipt(m,receiver!,target!)),label).toBe(true);
    expect((await c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"}))?.head.permissionSequence,label).toBe(3);
    expect(await c.owner.financialSource.enroll({original:c.original,registration:c.registration}),label).toMatchObject({permissionSequence:3});
    expect(await c.owner.financialSource.enroll({original:c.original,registration:{...c.registration,sourceRef:"replacement_source"}}),label).toBeUndefined();
  }}finally{await f.close();}
},30_000);

test("enrollment CAS rejects a stale complete roster and tombstones retain original history after real Workspace deletion",async()=>{
  const f=await adapters();try{for(const{label,store}of f.rows){
    const c=await enrolled(store,`terminal_${label}`);
    const member=(await store.getWorkspaceMember(c.workspace.id,"actor_original"))!;
    await store.putWorkspaceMember({...member,status:"suspended"});
    const changed=await c.owner.financialSource.prepareEnrollment({workspaceId:c.workspace.id});
    expect(await c.owner.financialSource.enroll({original:changed!,registration:c.registration}),label).toBeUndefined();
    expect(await store.deleteWorkspace(c.workspace.id),label).toBe(true);
    const h=await c.owner.financialSource.readHead(c.workspace.id);
    expect(h,label).toMatchObject({closed:true,permissionSequence:2});
    const events=await c.owner.financialSource.listRawEvents({workspaceId:c.workspace.id,afterSequence:0,limit:64});
    expect(events.map(e=>[e.permissionSequence,e.kind,e.previousEventRef]),label).toEqual([[1,"member-update",null],[2,"workspace-delete",events[0]!.eventRef]]);
    expect(await c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"}),label).toBeUndefined();
    await expect(Promise.resolve().then(()=>store.putWorkspace(c.workspace))).rejects.toThrow();
    await expect(Promise.resolve().then(()=>store.putWorkspaceMember({...member,status:"active"}))).rejects.toThrow();
    expect(await c.owner.financialSource.readHead(c.workspace.id),label).toEqual(h);
    expect(await c.owner.financialSource.enroll({original:c.original,registration:{...c.registration,incarnation:"replacement_incarnation"}}),label).toBeUndefined();
    // Raw full payload and original binding are retained without ephemeral FKs.
    expect(events[1]!.payloadJson,label).toContain(c.workspace.id);
    expect(await store.getWorkspaceBillingBinding(c.workspace.id),label).toEqual(c.original.binding);
  }}finally{await f.close();}
},30_000);

test("actual enrollment census does not swallow a pre-enrollment insert and ordinary unenrolled writes never enroll",async()=>{
  const f=await adapters();try{for(const{label,store}of f.rows){
    const owner=service(store,`enroll_${label}`),workspace=await owner.ensurePersonalWorkspaceForSharedAccount("actor_original",`enroll-${label}`);
    const intent=await owner.billingBindings.prepare({workspaceId:workspace.id,billingAuthority:"fixture",actorAccountId:"actor_original"});
    await owner.billingBindings.claim({workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:"actor_original",organizationRef:`org_enroll_${label}`,ownerAcknowledgementRef:"retained_ack"});
    const original=(await owner.financialSource.prepareEnrollment({workspaceId:workspace.id}))!;
    const member={...original.members[0]!,id:`new_${label}`,accountId:"additional_actor",roles:["viewer" as const]};
    await store.putWorkspaceMember(member);
    expect(await owner.financialSource.readHead(workspace.id),label).toBeUndefined();
    const registration={sourceRef:`enroll_${label}`,incarnation:"original",genesisDigest:"b".repeat(64),requiredReceivers:[{receiverRef:"financial",targetRef:"original_target"}]};
    expect(await owner.financialSource.enroll({original,registration}),label).toBeUndefined();
    const fresh=(await owner.financialSource.prepareEnrollment({workspaceId:workspace.id}))!;
    expect(fresh.members,label).toHaveLength(2);
    expect(await owner.financialSource.enroll({original:fresh,registration}),label).toMatchObject({permissionSequence:0});
    await store.putWorkspaceMember({...member,status:"suspended"});
    expect(await owner.financialSource.readHead(workspace.id),label).toMatchObject({permissionSequence:1});
  }}finally{await f.close();}
},30_000);

test("actual D1 batch and PostgreSQL transaction constraint failure rollback member mutation AND raw outbox/head together",async()=>{
  const f=await adapters();try{for(const{label,store}of f.rows.filter(r=>r.label!=="memory")){
    const c=await enrolled(store,`rollback_${label}`),member=(await store.getWorkspaceMember(c.workspace.id,"actor_original"))!;
    if(label==="native-d1"){
      await expect(f.native.batch([
        f.native.prepare("update workspace_members set status='suspended',record_json=? where workspace_id=?").bind(JSON.stringify({...member,status:"suspended"}),c.workspace.id),
        f.native.prepare("insert into workspace_financial_receipts(event_ref,receiver_ref,target_ref,record_json) values(null,'x','x','{}')"),
      ])).rejects.toThrow();
    }else{
      await expect(f.postgres.transaction(async tx=>{
        await tx.query("update takosumi_workspace_members set status='suspended',member_json=$1::jsonb where workspace_id=$2",[JSON.stringify({...member,status:"suspended"}),c.workspace.id]);
        await tx.query("insert into takosumi_workspace_financial_receipts(event_ref,receiver_ref,target_ref,record_json) values(null,'x','x','{}')");
      })).rejects.toThrow();
    }
    expect(await store.getWorkspaceMember(c.workspace.id,"actor_original"),label).toEqual(member);
    expect(await c.owner.financialSource.readHead(c.workspace.id),label).toEqual(c.head);
    expect(await c.owner.financialSource.listRawEvents({workspaceId:c.workspace.id,afterSequence:0,limit:64}),label).toEqual([]);
  }}finally{await f.close();}
},30_000);

test("tampered physical mutation hooks refuse source authority on both actual SQL backends",async()=>{
  const f=await adapters();try{for(const{label,store}of f.rows.filter(r=>r.label!=="memory")){
    const c=await enrolled(store,`hooks_${label}`);
    if(label==="native-d1"){
      await expect(f.native.prepare("update workspaces set id=? where id=?").bind(`replacement_${label}`,c.workspace.id).run()).rejects.toThrow();
      await expect(f.native.prepare("delete from workspace_financial_sources where workspace_id=?").bind(c.workspace.id).run()).rejects.toThrow();
    }else{
      await expect(f.postgres.query("update takosumi_workspaces set id=$1 where id=$2",[`replacement_${label}`,c.workspace.id])).rejects.toThrow();
      await expect(f.postgres.query("delete from takosumi_workspace_financial_sources where workspace_id=$1",[c.workspace.id])).rejects.toThrow();
    }
    expect(await c.owner.financialSource.readHead(c.workspace.id),label).toEqual(c.head);
    if(label==="native-d1")await f.native.prepare("drop trigger workspace_members_financial_source_update").run();
    else await f.postgres.query("alter table takosumi_workspace_members disable trigger takosumi_workspace_members_financial_source");
    await expect(c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"})).rejects.toThrow("trigger qualification failed");
  }}finally{await f.close();}
},30_000);

test("actual canonical archive/management/strict-delete seams advance the source; retained memory references cannot bypass it",async()=>{
  const f=await adapters();try{for(const{label,store}of f.rows){
    const c=await enrolled(store,`lifecycle_${label}`);
    await c.owner.updateWorkspaceForAccount(c.workspace.id,{archived:true},"actor_original",undefined,{requireCurrentMembership:true});
    expect(await c.owner.financialSource.readHead(c.workspace.id),label).toMatchObject({permissionSequence:1,closed:false});
    expect(await c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"}),label).toBeUndefined();
    await c.owner.updateWorkspaceForAccount(c.workspace.id,{archived:false},"actor_original",undefined,{requireCurrentMembership:true});
    const authority=(await store.getWorkspaceManagement(c.workspace.id))!;
    await store.beginWorkspaceDraining(c.workspace.id,authority);
    expect(await c.owner.financialSource.readHead(c.workspace.id),label).toMatchObject({permissionSequence:3,managementState:"draining"});
    expect((await store.getWorkspaceManagement(c.workspace.id))?.managementEpoch,label).toBe(2);
    const deletion=await enrolled(store,`strictdelete_${label}`,"deletion_actor");
    await store.putWorkspaceMember({id:`extra_${label}`,workspaceId:deletion.workspace.id,accountId:"extra",roles:["viewer"],status:"active",createdAt:deletion.workspace.createdAt,updatedAt:deletion.workspace.updatedAt});
    const before=(await deletion.owner.financialSource.readHead(deletion.workspace.id))!.permissionSequence;
    await deletion.owner.deleteWorkspaceForAccount(deletion.workspace.id,"deletion_actor",undefined,{requireCurrentMembership:true});
    const terminal=(await deletion.owner.financialSource.readHead(deletion.workspace.id))!;
    expect(terminal.closed,label).toBe(true);expect(terminal.permissionSequence,label).toBeGreaterThan(before);
    const deleteEvents=await deletion.owner.financialSource.listRawEvents({workspaceId:deletion.workspace.id,afterSequence:before,limit:64});
    expect(deleteEvents.at(-1)?.kind,label).toBe("workspace-delete");
    expect(deleteEvents.map(e=>e.permissionSequence),label).toEqual(Array.from({length:terminal.permissionSequence-before},(_,i)=>before+i+1));
    expect(await store.listWorkspaceMembers(deletion.workspace.id),label).toEqual([]);
  }
  const memory=f.rows[0]!.store,c=await enrolled(memory,"alias_memory","alias_actor");
  const old=c.workspace as {displayName:string};old.displayName="caller-mutated-original";
  expect((await memory.getWorkspace(c.workspace.id))?.displayName).not.toBe(old.displayName);
  const stored=(await memory.getWorkspaceMember(c.workspace.id,"alias_actor"))!;
  expect(()=>{(stored as {status:string}).status="suspended";}).toThrow();
  expect(await c.owner.financialSource.readHead(c.workspace.id)).toMatchObject({permissionSequence:0});
  }finally{await f.close();}
},30_000);

test("actual IdentityReconciliation apply inserts its member and raw financial event in the same native operation across all stores",async()=>{
  const f=await adapters();try{for(const{label,store}of f.rows){
    const target=await enrolled(store,`recon_target_${label}`),source=await enrolled(store,`recon_source_${label}`,"source_account");
    const now=Date.parse("2026-10-15T00:00:00.000Z"),operationId=`source_recon_${label}`;
    let state:ControlMergeAdmission={operationId,operationRevision:1,planningRevision:1,sourceAccountId:"source_account",targetAccountId:"actor_original",
      sourceProof:{receiptId:`retained_source_proof_${label}`,identityGeneration:2,provedAt:now-1000},
      targetProof:{receiptId:`retained_target_proof_${label}`,identityGeneration:3,provedAt:now-1000},
      browserBindingHash:`retained_browser_${label}`,policyVersion:"source-fixture/v1",createdAt:now-2000,expiresAt:now+60000,phase:"planning"};
    // This is the existing private owner admission fixture, not Accounts/RP
    // success, a real Financial receipt, or a registration/Principal grant.
    const authority:ControlIdentityAuthorityReader={
      async readMergeAdmission(input){return input.operationId===state.operationId&&input.phase===state.phase?structuredClone(state):undefined;},
      async readUnlinkAdmission(){return undefined;},async readRecoveryAdmission(){return undefined;},
    };
    let id=0;const identity=new IdentityReconciliationService({store,authority,newId:kind=>`${kind}_${label}_${++id}`,now:()=>new Date(now)});
    const plan=await identity.prepareMerge({operationId});
    state={...state,phase:"reserved",operationRevision:2,contextPlan:{planId:plan.planId,digest:plan.digest,planningRevision:plan.planningRevision,authorityVersion:plan.authorityVersion},
      contextAcceptances:{source:{receiptId:`accept_source_${label}`,proofReceiptId:state.sourceProof.receiptId,identityGeneration:2,acceptedAt:now-100,planDigest:plan.digest},
        target:{receiptId:`accept_target_${label}`,proofReceiptId:state.targetProof.receiptId,identityGeneration:3,acceptedAt:now-100,planDigest:plan.digest}},consentAt:now};
    const ack=await identity.applyMerge({operationId,planDigest:plan.digest});
    expect(ack.kind,label).toBe("merge-applied");
    expect(await store.getWorkspaceMember(source.workspace.id,"actor_original"),label).toMatchObject({status:"active",roles:["owner"]});
    expect(await source.owner.financialSource.readHead(source.workspace.id),label).toMatchObject({permissionSequence:1});
    expect(await target.owner.financialSource.readHead(target.workspace.id),label).toMatchObject({permissionSequence:0});
    expect(await store.listIdentityReconciliationEvents(operationId),label).toHaveLength(2);
    const events=await source.owner.financialSource.listRawEvents({workspaceId:source.workspace.id,afterSequence:0,limit:64});
    expect(events,label).toHaveLength(1);expect(events[0]?.kind,label).toBe("member-insert");
    expect(await identity.applyMerge({operationId,planDigest:plan.digest}),label).toEqual(ack);
    expect(await source.owner.financialSource.readHead(source.workspace.id),label).toMatchObject({permissionSequence:1});
  }}finally{await f.close();}
},30_000);

test("concurrent FIRST enrollment and a lost committed acknowledgement retain one original incarnation without minting replacement authority",async()=>{
  const f=await adapters();try{for(const{label,store}of f.rows){
    const owner=service(store,`first_race_${label}`),workspace=await owner.ensurePersonalWorkspaceForSharedAccount("actor_original",`first-race-${label}`);
    const intent=await owner.billingBindings.prepare({workspaceId:workspace.id,billingAuthority:"fixture",actorAccountId:"actor_original"});
    await owner.billingBindings.claim({workspaceId:workspace.id,intentId:intent.intentId,actorAccountId:"actor_original",organizationRef:`org_first_${label}`,ownerAcknowledgementRef:"retained_ack"});
    const original=(await owner.financialSource.prepareEnrollment({workspaceId:workspace.id}))!;
    const registrations=[0,1].map(n=>({sourceRef:`first_${label}_${n}`,incarnation:`original_${n}`,genesisDigest:"b".repeat(64),requiredReceivers:[
      {receiverRef:"z_original_receiver",targetRef:"z_actual_target"},{receiverRef:"a_original_receiver",targetRef:"a_actual_target"}]}));
    const originalCommit=store.enrollWorkspaceFinancialSource.bind(store);
    let lost:Parameters<typeof originalCommit>[0]|undefined;
    store.enrollWorkspaceFinancialSource=async input=>{
      const captured=structuredClone(input),head=await originalCommit(captured);
      if(head&&!lost){lost=captured;throw new Error("synthetic committed response lost");}
      return head;
    };
    let results:PromiseSettledResult<Awaited<ReturnType<typeof originalCommit>>>[];
    try{results=await Promise.allSettled(Array.from({length:8},(_,i)=>owner.financialSource.enroll({original,registration:registrations[i%2]!})));}
    finally{store.enrollWorkspaceFinancialSource=originalCommit;}
    expect(results!.filter(r=>r.status==="rejected"),label).toHaveLength(1);
    const accepted=results!.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof originalCommit>>> => (r.status==="fulfilled"&&!!r.value));
    expect(accepted,label).toHaveLength(3);expect(new Set(accepted.map(r=>r.value!.sourceRef)).size,label).toBe(1);
    const retained=accepted[0]!.value!;
    expect(retained.requiredReceivers.map(r=>r.receiverRef),label).toEqual(["z_original_receiver","a_original_receiver"]);
    if(!lost)throw new Error("Missing actual committed response-loss injection");
    const restarted=service(store,`restart_${label}`);
    expect(await restarted.financialSource.enroll({original:lost.original,registration:lost.registration}),label).toEqual(retained);
    expect(await restarted.financialSource.listRawEvents({workspaceId:workspace.id,afterSequence:0,limit:64}),label).toEqual([]);
    expect(await restarted.financialSource.captureFinancialSourceSnapshot({workspaceId:workspace.id,actorAccountId:"unrelated_actor"}),label).toBeUndefined();
    await expect(Promise.resolve().then(()=>store.listWorkspaceFinancialRawEvents({workspaceId:workspace.id,afterSequence:0,limit:65}))).rejects.toThrow("Bounded");
  }}finally{await f.close();}
},30_000);

for(const variant of["when-false","update-subset","foreign-function"]as const){
  test(`PostgreSQL source qualification rejects altered actual trigger firing/binding: ${variant}`,async()=>{
    const postgres=await PGliteSqlClient.create();try{
      const store=new SqlOpenTofuControlStore({client:postgres}),c=await enrolled(store,`pgqual_${variant}`);
      const member=(await store.getWorkspaceMember(c.workspace.id,"actor_original"))!;
      await postgres.query("drop trigger takosumi_workspace_members_financial_source on takosumi_workspace_members");
      let fn="public.takosumi_financial_source_mutation";
      if(variant==="foreign-function"){
        await postgres.query("create schema financial_shadow");
        await postgres.query("create function financial_shadow.takosumi_financial_source_mutation() returns trigger language plpgsql as $$begin return NEW; end$$");
        fn="financial_shadow.takosumi_financial_source_mutation";
      }
      await postgres.query(`create trigger takosumi_workspace_members_financial_source before ${variant==="update-subset"?"update of account_id":"update"} or delete on takosumi_workspace_members for each row ${variant==="when-false"?"when(false)":""} execute function ${fn}()`);
      // A real physical UPDATE no longer produces an event in these fixtures.
      // Qualification must refuse that schema rather than attest its old head.
      await postgres.query("update takosumi_workspace_members set member_json=$1::jsonb where workspace_id=$2",[JSON.stringify({...member,roles:["owner","admin"]}),c.workspace.id]);
      expect((await postgres.query("select permission_sequence from takosumi_workspace_financial_sources where workspace_id=$1",[c.workspace.id])).rows[0]?.permission_sequence).toBe(0);
      await expect(c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"})).rejects.toThrow("trigger qualification failed");
    }finally{await postgres.close();}
  },30_000);
}

test("memory receipt custody uses injective source-event/receiver tuples for legal slash references",async()=>{
  const store=new InMemoryOpenTofuControlStore();
  const a=await enrolled(store,"collision_a","actor_a",{sourceRef:"a",requiredReceivers:[{receiverRef:"event/1/r",targetRef:"target_a"}]}),
    b=await enrolled(store,"collision_b","actor_b",{sourceRef:"a/event/1",requiredReceivers:[{receiverRef:"r",targetRef:"target_b"}]});
  for(const[c,actor]of[[a,"actor_a"],[b,"actor_b"]]as const){const m=(await store.getWorkspaceMember(c.workspace.id,actor))!;await store.putWorkspaceMember({...m,roles:["owner","admin"]});}
  const ea=(await store.listWorkspaceFinancialRawEvents({workspaceId:a.workspace.id,afterSequence:0,limit:64}))[0]!,
    eb=(await store.listWorkspaceFinancialRawEvents({workspaceId:b.workspace.id,afterSequence:0,limit:64}))[0]!;
  expect(`${ea.eventRef}/event/1/r`).toBe(`${eb.eventRef}/r`); // actual old delimiter collision
  const ma=await materialization(store,ea),mb=await materialization(store,eb);
  expect(await store.materializeWorkspaceFinancialEvent(ma)).toBe(true);expect(await store.materializeWorkspaceFinancialEvent(mb)).toBe(true);
  const ra=receipt(ma,"event/1/r","target_a"),rb=receipt(mb,"r","target_b");
  expect(await store.recordWorkspaceFinancialReceipt(ra)).toBe(true);
  expect(await b.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:b.workspace.id,actorAccountId:"actor_b"})).toBeUndefined();
  expect(await store.listWorkspaceFinancialPendingEvents({workspaceId:b.workspace.id,receiverRef:"r",afterSequence:0,limit:64})).toEqual([mb.materialization]);
  expect(await store.recordWorkspaceFinancialReceipt(rb)).toBe(true);
  expect(await store.recordWorkspaceFinancialReceipt(ra)).toBe(true);expect(await store.recordWorkspaceFinancialReceipt(rb)).toBe(true);
  expect((await a.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:a.workspace.id,actorAccountId:"actor_a"}))?.head.permissionSequence).toBe(1);
  expect((await b.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:b.workspace.id,actorAccountId:"actor_b"}))?.head.permissionSequence).toBe(1);
  const member=(await store.getWorkspaceMember(b.workspace.id,"actor_b"))!;await store.putWorkspaceMember({...member,roles:["owner","viewer"]});
  const next=(await store.listWorkspaceFinancialRawEvents({workspaceId:b.workspace.id,afterSequence:1,limit:64}))[0]!,mn=await materialization(store,next);
  expect(await store.materializeWorkspaceFinancialEvent(mn)).toBe(true);expect(await store.recordWorkspaceFinancialReceipt(receipt(mn,"r","target_b"))).toBe(true);
});

for(const variant of["partial-source","partial-event","collation","wrong-name"]as const){
  test(`native D1 source global uniqueness qualification rejects ${variant}`,async()=>{
    const f=await adapters();try{
      const store=f.rows.find(row=>row.label==="native-d1")!.store,c=await enrolled(store,`idx_${variant}`);
      const event=variant==="partial-event",table=event?"workspace_financial_events":"workspace_financial_sources",
        name=event?"workspace_financial_events_workspace_sequence_unique":"workspace_financial_sources_source_ref_unique",
        columns=event?"workspace_id,sequence":variant==="collation"?"source_ref collate nocase":"source_ref";
      await f.native.prepare(`drop index ${name}`).run();
      await f.native.prepare(`create unique index ${variant==="wrong-name"?"foreign_source_ref_index":name} on ${table}(${columns}) ${variant.startsWith("partial")?"where 0":""}`).run();
      await expect(verifyD1OpenTofuLedgerSchemaPredeployed(f.native)).rejects.toThrow();
      // Source ports must qualify the same actual global constraints on both
      // predeployed and bootstrap handles, without a missing-table fallback.
      await expect(c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"})).rejects.toThrow();
    }finally{await f.close();}
  },30_000);
}

for(const variant of["missing","when-false"]as const){
  test(`strict exported native D1 v75 readiness rejects ${variant} financial hook`,async()=>{
    const f=await adapters();try{
      const store=f.rows.find(row=>row.label==="native-d1")!.store,c=await enrolled(store,`strict_${variant}`);
      const original=await f.native.prepare("select sql from sqlite_master where type='trigger' and name='workspace_members_financial_source_update'").first<{sql:string}>();
      if(!original)throw new Error("Missing actual original hook");
      await f.native.prepare("drop trigger workspace_members_financial_source_update").run();
      if(variant==="when-false"){
        const altered=original.sql.replace("before update on workspace_members begin","before update on workspace_members when 0 begin");
        expect(altered).not.toBe(original.sql);await f.native.prepare(altered).run();
      }
      await expect(verifyD1OpenTofuLedgerSchemaPredeployed(f.native)).rejects.toThrow("trigger qualification failed");
      await expect(c.owner.financialSource.captureFinancialSourceSnapshot({workspaceId:c.workspace.id,actorAccountId:"actor_original"})).rejects.toThrow("trigger qualification failed");
      if(variant==="when-false")await f.native.prepare("drop trigger workspace_members_financial_source_update").run();
      await f.native.prepare(original.sql).run();await verifyD1OpenTofuLedgerSchemaPredeployed(f.native);
    }finally{await f.close();}
  },30_000);
}

test("PostgreSQL enrollment takes the canonical EXCLUSIVE gate before its FOR UPDATE entry (single-backend command-order proof)",async()=>{
  const postgres=await PGliteSqlClient.create();try{
    const initial=new SqlOpenTofuControlStore({client:postgres}),c=await enrolled(initial,"lock_order");
    const commands:string[]=[];
    const trace=(client:SqlClient):SqlClient=>({
      query:async(sql,params)=>{commands.push(sql);return client.query(sql,params);},
      transaction:async(action)=>client.transaction(tx=>action(trace(tx)as SqlTransaction)),
    });
    const store=new SqlOpenTofuControlStore({client:trace(postgres)}),owner=service(store,"lock_order_reader");
    expect(await owner.financialSource.enroll({original:c.original,registration:c.registration})).toEqual(c.head);
    expect(commands[0]).toMatch(/^lock table takosumi_workspaces, takosumi_workspace_members in exclusive mode$/u);
    expect(commands[1]).toMatch(/^select id from takosumi_workspaces .* for update$/u);
    // This is actual PGlite SQL/transaction ordering, not a claim that PGlite
    // supplies two PostgreSQL sessions or exercises native deadlock detection.
    const member=(await store.getWorkspaceMember(c.workspace.id,"actor_original"))!;
    await owner.upsertWorkspaceMember({workspaceId:c.workspace.id,accountId:member.accountId,actorAccountId:member.accountId,roles:["owner","admin"],requireCurrentMembership:true});
    expect((await owner.financialSource.readHead(c.workspace.id))?.permissionSequence).toBe(1);
  }finally{await postgres.close();}
},30_000);
