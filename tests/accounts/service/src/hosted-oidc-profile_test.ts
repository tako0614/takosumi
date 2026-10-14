import { expect, test } from "bun:test";
import { createEphemeralAccountsHandler, createAccountsHandler, type OidcClientRegistration } from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore, type AccountsStore, type TokenRecord } from "../../../../accounts/service/src/store.ts";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { rotateAccountSession, serializeAccountSessionCookie, requireAccountsBearer, requireAccountSession, handleHostedGlobalLogout, handleAccountSessionMeDelete, HOSTED_ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { HOSTED_REFRESH_ABSOLUTE_MS, HOSTED_SESSION_IDLE_MS, hostedIssuerSessionId } from "../../../../accounts/service/src/hosted-oidc-profile.ts";
import { base64UrlEncodeBytes, sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { createSharedAccountWorkspaceDirectory } from "../../../../accounts/service/src/shared-account-workspace.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const issuer = "https://issuer.example.test";
const subject = "tsub_shared_customer" as const;
const verifier = "v".repeat(43);
const registrations = (): OidcClientRegistration[] => ["hosted", "takoserver"].map((clientId) => ({
  clientId, profile: "shared-account", enabled: true, clientSecret: `secret-${clientId}`,
  tokenEndpointAuthMethod: "client_secret_basic", allowedScopes: ["openid", "email", "profile", "offline_access"],
  redirectUris: [`https://${clientId}.example.test/auth/callback`],
}));

async function fixture(store: AccountsStore = new InMemoryAccountsStore()) {
  const now = Date.now();
  await store.saveAccount({subject,email:"User@example.test",emailVerified:true,displayName:"Customer",picture:"https://images.example.test/user.png",createdAt:now,updatedAt:now});
  await store.saveAccountEmailProof?.({subject,address:"User@example.test",normalizedAddress:"User@example.test",providerId:"google",upstreamIssuer:"https://accounts.google.com",upstreamSubject:"immutable-upstream",verification:"provider",authoritative:true,observedAt:now,validUntil:now+300_000});
  const session = await rotateAccountSession({store,subject,now,ttlMs:999_999,hostedPolicy:true,freshlyAuthenticatedAt:Math.floor(now/1000)});
  const cookie = `${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${session.sessionId}`;
  const clients = registrations();
  const handler = await createEphemeralAccountsHandler({issuer,store,clients,hostedSessionPolicy:true,allowEphemeralKeyOnHttpsIssuer:true});
  const challenge = base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
  function authorizeUrl(clientId = "hosted", scope="openid email profile offline_access") {
    const url = new URL(`${issuer}/oauth/authorize`);
    url.search = new URLSearchParams({response_type:"code",client_id:clientId,redirect_uri:`https://${clientId}.example.test/auth/callback`,scope,state:"csrf-state",nonce:"nonce-transaction",code_challenge:challenge,code_challenge_method:"S256"}).toString();
    return url;
  }
  async function grant(clientId = "hosted",scope="openid email profile offline_access") {
    const url = authorizeUrl(clientId,scope);
    let response = await handler(new Request(url,{headers:{cookie}}));
    if (response.status === 200) {
      const page = await response.text();
      const transaction = page.match(/name="consent_transaction" value="([^"]+)"/)?.[1];
      expect(transaction).toBeTruthy();
      response = await handler(new Request(url,{method:"POST",headers:{cookie,origin:issuer,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({consent_transaction:transaction!,approve:"yes"})}));
    }
    expect(response.status).toBe(302);
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
    expect(code).toStartWith("hcode_");
    const exchange = await token({grant_type:"authorization_code",code,redirect_uri:`https://${clientId}.example.test/auth/callback`,code_verifier:verifier},clientId);
    expect(exchange.status).toBe(200);
    return {code, ...(await exchange.json()) as {access_token:string;refresh_token?:string;id_token:string;expires_in:number;scope:string}};
  }
  function token(body:Record<string,string>,clientId="hosted",authenticate=true) {
    return handler(new Request(`${issuer}/oauth/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",...(authenticate?{authorization:`Basic ${btoa(`${clientId}:secret-${clientId}`)}`}:{})},body:new URLSearchParams(body)}));
  }
  async function introspect(accessToken:string,clientId="hosted") {
    const response=await handler(new Request(`${issuer}/oauth/introspect`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${btoa(`${clientId}:secret-${clientId}`)}`},body:new URLSearchParams({token:accessToken})}));
    return response.json() as Promise<Record<string,unknown>>;
  }
  return {store,clients,handler,session,cookie,authorizeUrl,grant,token,introspect};
}

function claims(jwt:string):Record<string,unknown> { return JSON.parse(Buffer.from(jwt.split(".")[1]!,"base64url").toString()); }

test("hosted HTTP flow shares canonical Accounts ID, signs ES256, scopes claims and has independent client sids",async()=>{
  const f=await fixture();
  const hosted=await f.grant(); const server=await f.grant("takoserver","openid");
  const a=claims(hosted.id_token), b=claims(server.id_token);
  expect(a).toMatchObject({iss:issuer,sub:subject,aud:"hosted",nonce:"nonce-transaction",auth_time:Math.floor((f.session.expiresAt-HOSTED_SESSION_IDLE_MS)/1000),email:"User@example.test",email_verified:true});
  expect(a.auth_time).toBe(Math.floor((await f.store.findAccountSession(f.session.sessionId))!.authTime!));
  expect(Number(a.exp)-Number(a.iat)).toBe(300);expect(hosted.expires_in).toBe(300);
  expect(b.sub).toBe(subject);expect(b.aud).toBe("takoserver");expect(b.sid).not.toBe(a.sid);
  expect(b.email).toBeUndefined();expect(b.name).toBeUndefined();expect(b.takosumi).toBeUndefined();expect(a.takosumi).toBeUndefined();
  expect(a.sid).not.toBe(f.session.sessionId);expect(a.sid).not.toBe(await hostedIssuerSessionId(f.session.sessionId));
  const jwks=await (await f.handler(new Request(`${issuer}/oauth/jwks`))).json() as {keys:JsonWebKey[]};
  const key=await crypto.subtle.importKey("jwk",jwks.keys[0]!,{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  const parts=hosted.id_token.split(".");
  expect(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,Buffer.from(parts[2]!,"base64url"),new TextEncoder().encode(parts.slice(0,2).join(".")))).toBe(true);
  const wrong=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
  expect(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},wrong.publicKey,Buffer.from(parts[2]!,"base64url"),new TextEncoder().encode(parts.slice(0,2).join(".")))).toBe(false);
  expect(await f.introspect(hosted.access_token)).toEqual({active:true,token_use:"oauth_access",client_id:"hosted",sub:subject,aud:"hosted",scope:"openid email profile offline_access",exp:a.exp});
  expect(await f.introspect(hosted.access_token,"takoserver")).toEqual({active:false});
  const info=await (await f.handler(new Request(`${issuer}/oauth/userinfo`,{headers:{authorization:`Bearer ${server.access_token}`}}))).json();
  expect(info).toEqual({sub:subject,aud:"takoserver",scope:"openid"});
});

test("hosted consent is browser-bound, single-use, exact-Origin and excludes silent first consent",async()=>{
  const f=await fixture(); const url=f.authorizeUrl();url.searchParams.set("prompt","none");
  const silent=await f.handler(new Request(url,{headers:{cookie:f.cookie}}));expect(new URL(silent.headers.get("location")!).searchParams.get("error")).toBe("consent_required");
  url.searchParams.delete("prompt");
  const page=await f.handler(new Request(url,{headers:{cookie:f.cookie}}));
  const tx=(await page.text()).match(/name="consent_transaction" value="([^"]+)"/)![1]!;
  const post=(origin:string,cookie=f.cookie)=>f.handler(new Request(url,{method:"POST",headers:{origin,cookie,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({approve:"yes",consent_transaction:tx})}));
  expect((await post("https://attacker.example.test")).status).toBe(403);
  expect((await post(issuer)).status).toBe(302);
  expect((await post(issuer)).status).toBe(400);
});

for(const [name,change] of [
  ["nonce",(u:URL)=>u.searchParams.delete("nonce")],
  ["state",(u:URL)=>u.searchParams.delete("state")],
  ["plain PKCE",(u:URL)=>u.searchParams.set("code_challenge_method","plain")],
  ["wrong redirect",(u:URL)=>u.searchParams.set("redirect_uri","https://hosted.example.test/auth/callback/")],
  ["Workspace selector",(u:URL)=>u.searchParams.set("workspace_id","ws_legacy")],
  ["resource",(u:URL)=>u.searchParams.set("resource","https://business.example.test")],
  ["claims object",(u:URL)=>u.searchParams.set("claims","{}")],
  ["undeclared delegation scope",(u:URL)=>u.searchParams.set("scope","openid capsules:write")],
  ["missing openid",(u:URL)=>u.searchParams.set("scope","email")],
  ["duplicate audience",(u:URL)=>u.searchParams.append("client_id","takoserver")],
  ["invalid max_age",(u:URL)=>u.searchParams.set("max_age","-1")],
  ["contradictory prompt",(u:URL)=>u.searchParams.set("prompt","none login")],
] as const) test(`hosted authorize rejects ${name}`,async()=>{
  const f=await fixture();const url=f.authorizeUrl();change(url);expect((await f.handler(new Request(url,{headers:{cookie:f.cookie}}))).status).toBe(400);
});

test("client_secret_post and wrong PKCE cannot exchange hosted code",async()=>{
  const f=await fixture();const grant=await f.grant();
  const wrong=await f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!,client_id:"hosted",client_secret:"secret-hosted"},"hosted",false);
  expect(wrong.status).toBe(401);expect((await f.introspect(grant.access_token)).active).toBe(true);
  const unknown=f.authorizeUrl();unknown.searchParams.set("prompt","none");
  const authorize=await f.handler(new Request(unknown,{headers:{cookie:f.cookie}}));
  const code=new URL(authorize.headers.get("location")!).searchParams.get("code")!;
  expect((await f.token({grant_type:"authorization_code",code,redirect_uri:"https://hosted.example.test/auth/callback",code_verifier:"w".repeat(43)})).status).toBe(400);
});

test("hosted refresh preserves auth_time, nonce, sid and absolute deadline; replay revokes descendants",async()=>{
  const f=await fixture();const grant=await f.grant();const initial=claims(grant.id_token);
  const original=(await f.store.findRefreshToken(grant.refresh_token!))!;
  const response=await f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!});expect(response.status).toBe(200);
  const next=await response.json() as {refresh_token:string;access_token:string;id_token:string};const after=claims(next.id_token);
  expect(after.auth_time).toBe(initial.auth_time);expect(after.sid).toBe(initial.sid);expect(after.nonce).toBe(initial.nonce);expect(after.sub).toBe(subject);
  expect((await f.store.findRefreshToken(next.refresh_token))!.familyExpiresAt).toBe(original.familyExpiresAt);
  expect((await f.store.findRefreshToken(next.refresh_token))!.familyStartedAt).toBe(original.familyStartedAt);
  expect((await f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!},"takoserver")).status).toBe(400);
  expect((await f.introspect(next.access_token)).active).toBe(true);
  expect((await f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!})).status).toBe(400);
  expect(await f.introspect(next.access_token)).toEqual({active:false});
  expect((await f.token({grant_type:"refresh_token",refresh_token:next.refresh_token})).status).toBe(400);
});

test("concurrent refresh across replicas has at most one response and no surviving authority",async()=>{
  const f=await fixture();const grant=await f.grant();
  const results=await Promise.all([f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!}),f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!})]);
  expect(results.filter((r)=>r.status===200).length).toBeLessThanOrEqual(1);expect(results.some((r)=>r.status===400)).toBe(true);
  for(const response of results) if(response.status===200) expect(await f.introspect((await response.json() as {access_token:string}).access_token)).toEqual({active:false});
  expect(await f.introspect(grant.access_token)).toEqual({active:false});
});

test("code replay only revokes the authenticated owning client's grant",async()=>{
  const f=await fixture();const grant=await f.grant();
  const body={grant_type:"authorization_code",code:grant.code,redirect_uri:"https://hosted.example.test/auth/callback",code_verifier:verifier};
  expect((await f.token(body,"takoserver")).status).toBe(400);expect((await f.introspect(grant.access_token)).active).toBe(true);
  expect((await f.token(body,"hosted",false)).status).toBe(401);expect((await f.introspect(grant.access_token)).active).toBe(true);
  expect((await f.token(body)).status).toBe(400);expect(await f.introspect(grant.access_token)).toEqual({active:false});
});

test("refresh has seven-day idle and thirty-day absolute bounds without scope widening",async()=>{
  const f=await fixture();const grant=await f.grant();const record=(await f.store.findRefreshToken(grant.refresh_token!))!;
  expect(record.familyExpiresAt!-record.familyStartedAt!).toBe(HOSTED_REFRESH_ABSOLUTE_MS);
  expect(record.expiresAt-record.familyStartedAt!).toBeLessThanOrEqual(7*24*60*60*1000+100);
  expect((await f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!,scope:"openid capsules:write"})).status).toBe(400);
  await f.store.saveRefreshToken(grant.refresh_token!,{...record,familyExpiresAt:Date.now()-1});
  expect((await f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!})).status).toBe(400);expect(await f.introspect(grant.access_token)).toEqual({active:false});
});

test("client disable/re-enable cannot restore grants observed disabled",async()=>{
  const f=await fixture();const grant=await f.grant();f.clients[0]!.enabled=false;
  expect(await f.introspect(grant.access_token)).toEqual({error:"invalid_client"});f.clients[0]!.enabled=true;
  expect(await f.introspect(grant.access_token)).toEqual({error:"invalid_client"});
  expect((await f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!})).status).toBe(400);
});

test("durable disabled-client marker rejects old enabled replicas and requires a new versioned client ID",async()=>{
  const f=await fixture();const grant=await f.grant();
  const old=await createEphemeralAccountsHandler({issuer,store:f.store,clients:registrations(),hostedSessionPolicy:true,allowEphemeralKeyOnHttpsIssuer:true});
  const disabled=await createEphemeralAccountsHandler({issuer,store:f.store,clients:registrations().map((c)=>({...c,enabled:c.clientId!=="hosted"})),hostedSessionPolicy:true,allowEphemeralKeyOnHttpsIssuer:true});
  expect((await disabled(new Request(f.authorizeUrl(),{headers:{cookie:f.cookie}}))).status).toBe(400);
  expect((await old(new Request(f.authorizeUrl(),{headers:{cookie:f.cookie}}))).status).toBe(400);
  expect((await old(new Request(`${issuer}/oauth/userinfo`,{headers:{authorization:`Bearer ${grant.access_token}`}}))).status).toBe(401);
  expect((await old(new Request(`${issuer}/oauth/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${btoa("hosted:secret-hosted")}`},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:grant.refresh_token!})}))).status).toBe(400);
  const nextClient:OidcClientRegistration={...registrations()[0]!,clientId:"hosted-v2",clientSecret:"secret-hosted-v2",redirectUris:["https://hosted-v2.example.test/auth/callback"]};
  const next=await createEphemeralAccountsHandler({issuer,store:f.store,clients:[nextClient],hostedSessionPolicy:true,allowEphemeralKeyOnHttpsIssuer:true});
  const url=f.authorizeUrl("hosted-v2");const consent=await next(new Request(url,{headers:{cookie:f.cookie}}));expect(consent.status).toBe(200);
  const tx=(await consent.text()).match(/name="consent_transaction" value="([^"]+)"/)![1]!;
  const authorize=await next(new Request(url,{method:"POST",headers:{cookie:f.cookie,origin:issuer,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({approve:"yes",consent_transaction:tx})}));expect(authorize.status).toBe(302);
  const code=new URL(authorize.headers.get("location")!).searchParams.get("code")!;
  const response=await next(new Request(`${issuer}/oauth/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${btoa("hosted-v2:secret-hosted-v2")}`},body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:nextClient.redirectUris[0]!,code_verifier:verifier})}));expect(response.status).toBe(200);
  expect(claims((await response.json() as {id_token:string}).id_token).sub).toBe(subject);
});

test("durable account generation rejects pre-merge sessions, tokens and late stale grant writes",async()=>{
  const f=await fixture();const grant=await f.grant();const record=(await f.store.findAccessToken(grant.access_token))!;
  let generation=1;f.store.getAccountAuthenticationGeneration=()=>generation;
  expect(await f.introspect(grant.access_token)).toEqual({active:false});
  expect(new URL((await f.handler(new Request(f.authorizeUrl(),{headers:{cookie:f.cookie}}))).headers.get("location")!).pathname).toBe("/sign-in");
  await f.store.saveAccessToken("late-stale-token",record);expect(await f.introspect("late-stale-token")).toEqual({active:false});
  const current=await rotateAccountSession({store:f.store,subject,now:Date.now(),ttlMs:300_000,hostedPolicy:true});expect((await f.store.findAccountSession(current.sessionId))!.identityGeneration).toBe(1);
  generation=2;expect((await requireAccountsBearer({request:new Request(`${issuer}/api/v1/workspaces`,{headers:{authorization:`Bearer ${current.sessionId}`}}),store:f.store,scope:"read"})).ok).toBe(false);
});

test("browser-cookie expiry preserves offline grant but explicit global logout revokes both clients",async()=>{
  const f=await fixture();const a=await f.grant(),b=await f.grant("takoserver");
  await f.store.deleteAccountSession(f.session.sessionId);
  expect((await f.introspect(a.access_token)).active).toBe(true);
  const logout=await f.handler(new Request(`${issuer}/api/v1/account/session/global-logout`,{method:"POST",headers:{cookie:f.cookie,origin:issuer}}));
  expect(logout.status).toBe(204);expect(logout.headers.get("set-cookie")).toContain("__Host-takosumi_session=");
  expect(await f.introspect(a.access_token)).toEqual({active:false});expect(await f.introspect(b.access_token,"takoserver")).toEqual({active:false});
  expect((await f.token({grant_type:"refresh_token",refresh_token:a.refresh_token!})).status).toBe(400);
});

test("hosted cookies are host-only, Secure, HttpOnly, bounded and fresh opaque values",async()=>{
  const f=await fixture();const cookie=serializeAccountSessionCookie(f.session.sessionId,{secure:true,maxAgeSeconds:365*24*60*60,hostedPolicy:true});
  expect(cookie).toStartWith("__Host-takosumi_session=sess_h_");expect(cookie).toContain("Secure");expect(cookie).toContain("HttpOnly");expect(cookie).toContain("Path=/");expect(cookie).toContain("SameSite=Lax");expect(cookie).toContain("Max-Age=604800");expect(cookie).not.toContain("Domain");
  expect(()=>serializeAccountSessionCookie(f.session.sessionId,{secure:false,maxAgeSeconds:300})).toThrow("Secure");
  const record=(await f.store.findAccountSession(f.session.sessionId))!;expect(record.expiresAt-record.createdAt).toBe(HOSTED_SESSION_IDLE_MS);
  await f.store.saveAccountSession({...record,absoluteExpiresAt:Date.now()-1});
  const response=await f.handler(new Request(f.authorizeUrl(),{headers:{cookie:f.cookie}}));expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
});

test("identity-only access token never authorizes account APIs, even with corrupt delegation scope",async()=>{
  const f=await fixture();const grant=await f.grant();const record=(await f.store.findAccessToken(grant.access_token))!;
  await f.store.saveAccessToken(grant.access_token,{...record,scope:"openid capsules:write"});
  expect((await requireAccountsBearer({request:new Request(`${issuer}/api/v1/control`,{headers:{authorization:`Bearer ${grant.access_token}`}}),store:f.store,scope:"write"})).ok).toBe(false);
  expect(await f.introspect(grant.access_token)).toEqual({active:false});
});

test("freshness requests do not accept ordinary upstream session establishment as credential reauthentication",async()=>{
  const f=await fixture();const record=(await f.store.findAccountSession(f.session.sessionId))!;await f.store.saveAccountSession({...record,reauthenticatedAt:undefined});
  const url=f.authorizeUrl();url.searchParams.set("prompt","login");const response=await f.handler(new Request(url,{headers:{cookie:f.cookie}}));
  const location=new URL(response.headers.get("location")!);expect(location.pathname).toBe("/sign-in");expect(location.searchParams.get("prompt")).toBe("login");
  const silent=f.authorizeUrl();silent.searchParams.set("prompt","none");silent.searchParams.set("max_age","0");
  const denied=await f.handler(new Request(silent,{headers:{cookie:f.cookie}}));expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("login_required");
});

test("legacy self-host static clients keep session cookies, profile and refresh behavior",async()=>{
  const store=new InMemoryAccountsStore();const now=Date.now();await store.saveAccount({subject,createdAt:now,updatedAt:now});await store.saveAccountSession({sessionId:"sess_legacy",subject,createdAt:now,expiresAt:now+60_000});
  const handler=await createEphemeralAccountsHandler({issuer:"http://localhost:8787",store,clients:[{clientId:"legacy",redirectUris:["app://callback"],allowedScopes:["openid","offline_access"],tokenEndpointAuthMethod:"none"}]});
  const challenge=base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
  const url=new URL("http://localhost:8787/oauth/authorize");url.search=new URLSearchParams({client_id:"legacy",redirect_uri:"app://callback",response_type:"code",scope:"openid offline_access",code_challenge:challenge}).toString();
  const authorize=await handler(new Request(url,{headers:{cookie:"takosumi_session=sess_legacy"}}));expect(authorize.status).toBe(302);
  const code=new URL(authorize.headers.get("location")!).searchParams.get("code")!;
  const exchanged=await handler(new Request("http://localhost:8787/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:"legacy",redirect_uri:"app://callback",grant_type:"authorization_code",code,code_verifier:verifier})}));
  expect(exchanged.status).toBe(200);const result=await exchanged.json() as {id_token:string;refresh_token:string};expect(claims(result.id_token).sub).toBe(subject);expect(claims(result.id_token).sid).toBeUndefined();expect(result.refresh_token).toStartWith("takrt_");
});

test("D1-backed hosted flow across two stores rotates and fails replay without raw credentials in documents",async()=>{
  const db=new SqliteFakeD1();const store=new D1AccountsStore(db as unknown as D1Database,{sessionHashSalt:"isolated-test-salt"});const f=await fixture(store);const grant=await f.grant();
  const replicaStore=new D1AccountsStore(db as unknown as D1Database,{sessionHashSalt:"isolated-test-salt"});
  const replica=await createEphemeralAccountsHandler({issuer,store:replicaStore,clients:f.clients,hostedSessionPolicy:true,allowEphemeralKeyOnHttpsIssuer:true});
  const request=()=>new Request(`${issuer}/oauth/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${btoa("hosted:secret-hosted")}`},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:grant.refresh_token!})});
  const renewed=await replica(request());expect(renewed.status).toBe(200);const next=await renewed.json() as {access_token:string};expect((await f.introspect(next.access_token)).active).toBe(true);
  expect((await f.handler(request())).status).toBe(400);expect(await f.introspect(next.access_token)).toEqual({active:false});
  const rows=await db.prepare("SELECT key, document FROM takosumi_accounts_documents").all<{key:string;document:string}>();const persisted=JSON.stringify(rows.results);
  expect(persisted).not.toContain(grant.access_token);expect(persisted).not.toContain(grant.refresh_token!);expect(persisted).not.toContain(f.session.sessionId);expect(persisted).not.toContain(grant.code);
});

async function directoryFixture() {
  const f=await fixture();
  const control=new InMemoryOpenTofuControlStore();let id=0;
  const service=new WorkspacesService({store:control,newId:(prefix)=>`${prefix}_directory_${++id}`});
  const operations:Pick<ControlPlaneOperations,"workspaces"|"members">={
    workspaces:{ensurePersonalWorkspace:service.ensurePersonalWorkspace.bind(service),ensurePersonalWorkspaceForSharedAccount:service.ensurePersonalWorkspaceForSharedAccount.bind(service),listWorkspaces:service.listWorkspaces.bind(service),listWorkspacesByOwner:service.listWorkspacesByOwner.bind(service),listWorkspacesForAccount:service.listWorkspacesForAccount.bind(service),listWorkspacesForAccountPage:service.listWorkspacesForAccountPage.bind(service),getWorkspaceForAccount:service.getWorkspaceForAccount.bind(service),getWorkspace:service.getWorkspace.bind(service),captureManagementAuthority:service.captureManagementAuthority.bind(service),createWorkspace:service.createWorkspace.bind(service),updateWorkspace:service.updateWorkspace.bind(service),updateWorkspaceForAccount:service.updateWorkspaceForAccount.bind(service),deleteWorkspaceForAccount:service.deleteWorkspaceForAccount.bind(service)},
    members:{getMember:control.getWorkspaceMember.bind(control),listMembers:control.listWorkspaceMembers.bind(control),upsertMember:async()=>{throw new Error("Directory cannot reconcile membership");}},
  };
  let billingEntered!:()=>void, billingRelease!:()=>void;
  const entered=new Promise<void>((resolve)=>{billingEntered=resolve;});
  const blocked=new Promise<void>((resolve)=>{billingRelease=resolve;});
  let pauseBilling=false;
  const directory=createSharedAccountWorkspaceDirectory({store:f.store,operations,resolveWorkspaceBilling:async({workspaceId})=>{
    if(pauseBilling){billingEntered();await blocked;}
    return {workspaceId,workspaceRef:"wrk_retained_directory_reference",organizationId:"org_retained_ledger"};
  }});
  const handler=await createEphemeralAccountsHandler({issuer,store:f.store,clients:f.clients,hostedSessionPolicy:true,sharedAccountWorkspaceDirectory:directory,allowEphemeralKeyOnHttpsIssuer:true});
  function request(path:string,token:string,method="GET",body?:unknown) {
    return handler(new Request(`${issuer}/api/v1/account/shared-workspaces${path}`,{method,headers:{authorization:`Bearer ${token}`,...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
  }
  return {...f,control,handler,request,entered,billingRelease,pause:()=>{pauseBilling=true;}};
}

test("dedicated first-party directory Bearer yields the same canonical account/Workspace for both RPs",async()=>{
  const f=await directoryFixture();const a=await f.grant(),b=await f.grant("takoserver");
  const bootstrap=await f.request("/bootstrap",a.access_token,"POST",{});expect(bootstrap.status).toBe(200);
  const {workspace}=await bootstrap.json() as {workspace:{id:string;ownerUserId:string}};expect(workspace.ownerUserId).toBe(subject);
  const second=await f.request("/bootstrap",b.access_token,"POST",{});expect(second.status).toBe(200);expect((await second.json() as {workspace:{id:string}}).workspace.id).toBe(workspace.id);
  const menu=await f.request("",a.access_token);expect(menu.status).toBe(200);
  const dto=await menu.json() as {accountId:string;personalWorkspaceId:string;choices:Array<{id:string;roles:string[]}>};
  expect(dto.accountId).toBe(subject);expect(dto.personalWorkspaceId).toBe(workspace.id);expect(dto.choices[0]!.roles).toEqual(["owner"]);expect(structuredClone(dto)).toEqual(dto);
  const selected=await f.request(`/${workspace.id}/select`,b.access_token,"POST",{});expect(selected.status).toBe(200);
  const billing=await f.request(`/${workspace.id}/billing-organization`,a.access_token);expect(await billing.json()).toEqual({workspaceId:workspace.id,workspaceRef:"wrk_retained_directory_reference",organizationId:"org_retained_ledger"});
  const created=await f.request("",a.access_token,"POST",{handle:"shared-team",displayName:"Shared team",type:"organization"});expect(created.status).toBe(201);
  const current=await f.control.getWorkspaceMember(workspace.id,subject);await f.control.putWorkspaceMember({...current!,status:"suspended"});
  expect((await f.request(`/${workspace.id}/select`,a.access_token,"POST",{})).status).toBe(403);
});

test("directory rejects spoofed IDs, legacy/PAT/Interface credentials, revoked/fenced/aliased grants and bad pagination",async()=>{
  const f=await directoryFixture();const grant=await f.grant();
  expect((await f.request("/bootstrap",grant.access_token,"POST",{accountId:"tsub_attacker"})).status).toBe(400);
  expect((await f.request("?limit=101",grant.access_token)).status).toBe(400);
  expect((await f.request("?limit=-1",grant.access_token)).status).toBe(400);
  await f.store.savePersonalAccessToken("pat-directory",{tokenId:"pat-directory-id",tokenPrefix:"pat",subject,name:"Directory denied",scopes:["admin"],createdAt:Date.now()});
  expect((await f.request("","pat-directory")).status).toBe(401);
  const record=(await f.store.findAccessToken(grant.access_token))!;
  await f.store.saveAccessToken("legacy-directory",{clientId:"hosted",scope:"openid",subject,takosumiSubject:subject,expiresAt:Date.now()+60_000});expect((await f.request("","legacy-directory")).status).toBe(401);
  await f.store.saveAccessToken("interface-directory",{...record,oidcProfile:undefined,role:"interface-runtime",audience:"https://resource.example.test",interfaceId:"if_id",interfaceBindingId:"if_bind",interfaceResolvedRevision:1,workspaceId:"ws_id"});expect((await f.request("","interface-directory")).status).toBe(401);
  const baseFind=f.store.findCanonicalAccount!.bind(f.store);f.store.findCanonicalAccount=async()=>({subject:"tsub_changed",createdAt:1,updatedAt:1});expect((await f.request("",grant.access_token)).status).toBe(401);f.store.findCanonicalAccount=baseFind;
  const baseFence=f.store.isAccountAuthenticationFenced!.bind(f.store);f.store.isAccountAuthenticationFenced=()=>true;expect((await f.request("",grant.access_token)).status).toBe(401);f.store.isAccountAuthenticationFenced=baseFence;
  f.clients[0]!.enabled=false;expect((await f.request("",grant.access_token)).status).toBe(401);f.clients[0]!.enabled=true;expect((await f.request("",grant.access_token)).status).toBe(401);
});

test("directory revalidates grant after owner billing wait and genuine issuer session still needs exact Origin",async()=>{
  const f=await directoryFixture();const grant=await f.grant();
  const bootstrap=await f.request("/bootstrap",grant.access_token,"POST",{});const {workspace}=await bootstrap.json() as {workspace:{id:string}};
  f.pause();const pending=f.request(`/${workspace.id}/billing-organization`,grant.access_token);await f.entered;
  await f.store.revokeHostedOidcGrant!(claims(grant.id_token).sid as string,Date.now());f.billingRelease();expect((await pending).status).toBe(401);
  const ambient=await f.handler(new Request(`${issuer}/api/v1/account/shared-workspaces/bootstrap`,{method:"POST",headers:{cookie:f.cookie,"content-type":"application/json",origin:"https://attacker.example.test"},body:"{}"}));expect(ambient.status).toBe(403);
  const genuine=await f.handler(new Request(`${issuer}/api/v1/account/shared-workspaces/bootstrap`,{method:"POST",headers:{cookie:f.cookie,"content-type":"application/json",origin:issuer},body:"{}"}));expect(genuine.status).toBe(200);
});

test("shared grants reject wrong issuer, audience and authentication metadata at all hosted read paths",async()=>{
  const f=await fixture();const grant=await f.grant();const record=(await f.store.findAccessToken(grant.access_token))!;
  for(const patch of [{issuer:"https://other-issuer.example.test"},{audience:"wrong-client"},{authTime:record.authTime!+1},{sid:"hsid_missing"},{subject:"tsub_other"}]) {
    await f.store.saveAccessToken(grant.access_token,{...record,...patch});
    expect(await f.introspect(grant.access_token)).toEqual({active:false});
    expect((await f.handler(new Request(`${issuer}/oauth/userinfo`,{headers:{authorization:`Bearer ${grant.access_token}`}}))).status).toBe(401);
  }
});

test("signing-key rotation and verified-email changes preserve canonical identity without inventing verification",async()=>{
  const f=await fixture();const grant=await f.grant();const account=(await f.store.findAccount(subject))!;
  await f.store.saveAccount({...account,email:"New@example.test",emailVerified:true});
  const rotated=await createEphemeralAccountsHandler({issuer,store:f.store,clients:f.clients,hostedSessionPolicy:true,allowEphemeralKeyOnHttpsIssuer:true});
  const response=await rotated(new Request(`${issuer}/oauth/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${btoa("hosted:secret-hosted")}`},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:grant.refresh_token!})}));expect(response.status).toBe(200);
  const next=await response.json() as {id_token:string};const c=claims(next.id_token);expect(c.sub).toBe(subject);expect(c.sid).toBe(claims(grant.id_token).sid);expect(c.email).toBe("New@example.test");expect(c.email_verified).toBe(false);
  const before=JSON.parse(Buffer.from(grant.id_token.split(".")[0]!,"base64url").toString()) as {kid:string};const after=JSON.parse(Buffer.from(next.id_token.split(".")[0]!,"base64url").toString()) as {kid:string};expect(after.kid).not.toBe(before.kid);
});

test("workerd + native D1 completes hosted HTTP flow and refresh race with hashed custody",async()=>{
  const build=await Bun.build({entrypoints:[resolve(import.meta.dir,"../fixtures/hosted-oidc-runtime.ts")],target:"browser",format:"esm",minify:true});
  expect(build.success,build.logs.map(String).join("\n")).toBe(true);
  const runtime=new Miniflare({compatibilityDate:"2026-07-17",modules:[{type:"ESModule",path:"hosted-oidc-runtime.mjs",contents:await build.outputs[0]!.text()}],d1Databases:["ACCOUNTS_TEST_DB"]});
  try {
    const setup=await runtime.dispatchFetch(`${issuer}/__fixture/session`);const {cookie}=await setup.json() as {cookie:string};
    const challenge=base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
    const url=new URL(`${issuer}/oauth/authorize`);url.search=new URLSearchParams({response_type:"code",client_id:"hosted",redirect_uri:"https://hosted.example.test/auth/callback",scope:"openid offline_access",nonce:"workerd-nonce",state:"workerd-state",code_challenge:challenge,code_challenge_method:"S256"}).toString();
    const consent=await runtime.dispatchFetch(url,{headers:{cookie},redirect:"manual"});expect(consent.status).toBe(200);
    const transaction=(await consent.text()).match(/name="consent_transaction" value="([^"]+)"/)![1]!;
    const authorized=await runtime.dispatchFetch(url,{method:"POST",headers:{cookie,origin:issuer,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({approve:"yes",consent_transaction:transaction}).toString(),redirect:"manual"});expect(authorized.status,await authorized.clone().text()).toBe(302);
    const code=new URL(authorized.headers.get("location")!).searchParams.get("code")!;
    const headers={"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${btoa("hosted:workerd-test-secret")}`};
    const exchanged=await runtime.dispatchFetch(`${issuer}/oauth/token`,{method:"POST",headers,body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:"https://hosted.example.test/auth/callback",code_verifier:verifier}).toString()});expect(exchanged.status).toBe(200);
    const grant=await exchanged.json() as {access_token:string;refresh_token:string;id_token:string};expect(claims(grant.id_token)).toMatchObject({iss:issuer,sub:"tsub_workerd_shared",aud:"hosted",nonce:"workerd-nonce"});
    const refresh=()=>runtime.dispatchFetch(`${issuer}/oauth/token`,{method:"POST",headers,body:new URLSearchParams({grant_type:"refresh_token",refresh_token:grant.refresh_token}).toString()});
    const race=await Promise.all([refresh(),refresh()]);expect(race.filter((r)=>r.status===200).length).toBeLessThanOrEqual(1);expect(race.some((r)=>r.status===400)).toBe(true);
    for(const result of race) if(result.status===200) {
      const next=await result.json() as {access_token:string};const active=await runtime.dispatchFetch(`${issuer}/oauth/introspect`,{method:"POST",headers,body:new URLSearchParams({token:next.access_token}).toString()});expect(await active.json()).toEqual({active:false});
    }
    const db=await runtime.getD1Database("ACCOUNTS_TEST_DB");const rows=await db.prepare("SELECT key,document FROM takosumi_accounts_documents").all();const persisted=JSON.stringify(rows.results);
    expect(persisted).not.toContain(grant.access_token);expect(persisted).not.toContain(grant.refresh_token);expect(persisted).not.toContain(code);expect(persisted).not.toContain(cookie.slice(cookie.indexOf("=")+1));
    expect(rows.results.filter((row)=>{const doc=JSON.parse(String(row.document));return doc.sid && doc.revokedAt !== undefined;}).length).toBeGreaterThanOrEqual(1);
  } finally {await runtime.dispose();}
});

test("revoking an old rotated refresh token revokes the lost response's current family",async()=>{
  const f=await fixture();const grant=await f.grant();
  const rotation=await f.token({grant_type:"refresh_token",refresh_token:grant.refresh_token!});expect(rotation.status).toBe(200);
  const next=await rotation.json() as {access_token:string;refresh_token:string};
  const revoke=(clientId:string)=>f.handler(new Request(`${issuer}/oauth/revoke`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${btoa(`${clientId}:secret-${clientId}`)}`},body:new URLSearchParams({token:grant.refresh_token!})}));
  expect((await revoke("takoserver")).status).toBe(200);expect((await f.introspect(next.access_token)).active).toBe(true);
  expect((await revoke("hosted")).status).toBe(200);expect(await f.introspect(next.access_token)).toEqual({active:false});
  expect((await f.token({grant_type:"refresh_token",refresh_token:next.refresh_token})).status).toBe(400);
});

test("global logout fences grants created by an authorization already in flight",async()=>{
  const f=await fixture();await f.grant();
  const original=f.store.saveHostedOidcGrant!.bind(f.store);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>((resolve)=>{entered=resolve;});const blocked=new Promise<void>((resolve)=>{release=resolve;});
  f.store.saveHostedOidcGrant=async(record)=>{entered();await blocked;await original(record);};
  const pending=f.handler(new Request(f.authorizeUrl(),{headers:{cookie:f.cookie}}));await started;
  expect((await f.handler(new Request(`${issuer}/api/v1/account/session/global-logout`,{method:"POST",headers:{cookie:f.cookie,origin:issuer}}))).status).toBe(204);
  release();const authorized=await pending;expect(authorized.status).toBe(302);
  const code=new URL(authorized.headers.get("location")!).searchParams.get("code")!;
  expect((await f.token({grant_type:"authorization_code",code,redirect_uri:"https://hosted.example.test/auth/callback",code_verifier:verifier})).status).toBe(400);
});

test("prompt=login accepts only a newly rotated fresh credential proof and completes consent once",async()=>{
  const f=await fixture();const url=f.authorizeUrl();url.searchParams.set("prompt","login");
  const start=await f.handler(new Request(url,{headers:{cookie:f.cookie}}));expect(start.status).toBe(302);
  const returned=new URL(new URL(start.headers.get("location")!).searchParams.get("return")!,issuer);expect(returned.searchParams.get("reauth")).toStartWith("hreauth_");
  const now=Date.now()+1000;const rotated=await rotateAccountSession({store:f.store,subject,oldSessionId:f.session.sessionId,now,ttlMs:60_000,hostedPolicy:true,freshlyAuthenticatedAt:Math.floor(now/1000)});
  const cookie=`${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${rotated.sessionId}`;
  const consent=await f.handler(new Request(returned,{headers:{cookie}}));expect(consent.status).toBe(200);
  const transaction=(await consent.text()).match(/name="consent_transaction" value="([^"]+)"/)![1]!;
  const authorized=await f.handler(new Request(returned,{method:"POST",headers:{cookie,origin:issuer,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({approve:"yes",consent_transaction:transaction})}));expect(authorized.status).toBe(302);
  expect(new URL(authorized.headers.get("location")!).searchParams.get("code")).toStartWith("hcode_");
});

test("hosted authorization code expires at sixty seconds and requires a registered confidential profile",async()=>{
  const f=await fixture();await f.grant();
  const authorized=await f.handler(new Request(f.authorizeUrl(),{headers:{cookie:f.cookie}}));
  const code=new URL(authorized.headers.get("location")!).searchParams.get("code")!;const record=(await f.store.consumeAuthorizationCode(code))!;
  expect(record.expiresAt-Date.now()).toBeGreaterThan(59_000);expect(record.expiresAt-Date.now()).toBeLessThanOrEqual(60_000);
  await f.store.saveAuthorizationCode(code,{...record,expiresAt:Date.now()});
  expect((await f.token({grant_type:"authorization_code",code,redirect_uri:"https://hosted.example.test/auth/callback",code_verifier:verifier})).status).toBe(400);
  expect(()=>createAccountsHandler({issuer,store:f.store,hostedSessionPolicy:true,clients:[{...f.clients[0]!,tokenEndpointAuthMethod:"none"}]})).toThrow("client_secret_basic");
  expect(()=>createAccountsHandler({issuer,store:f.store,clients:f.clients})).toThrow("hosted session policy");
});

test("client-owned hosted code evidence survives generic tombstone retention and wrong clients cannot consume fresh codes",async()=>{
  const f=await fixture();const grant=await f.grant();
  f.store.isAuthorizationCodeConsumed=()=>false;
  expect((await f.token({grant_type:"authorization_code",code:grant.code,redirect_uri:"https://hosted.example.test/auth/callback",code_verifier:verifier})).status).toBe(400);
  expect(await f.introspect(grant.access_token)).toEqual({active:false});
  const authorize=await f.handler(new Request(f.authorizeUrl(),{headers:{cookie:f.cookie}}));
  // The prior grant was revoked, so explicitly consent to the next fresh one.
  const transaction=(await authorize.text()).match(/name="consent_transaction" value="([^"]+)"/)![1]!;
  const approved=await f.handler(new Request(f.authorizeUrl(),{method:"POST",headers:{cookie:f.cookie,origin:issuer,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({approve:"yes",consent_transaction:transaction})}));
  const code=new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const body={grant_type:"authorization_code",code,redirect_uri:"https://hosted.example.test/auth/callback",code_verifier:verifier};
  expect((await f.token(body,"takoserver")).status).toBe(400);expect((await f.token(body,"hosted")).status).toBe(200);
});

test("shared profile supports stored secret verifiers and advertises only its identity scopes and claims",async()=>{
  const f=await fixture();const client=f.clients[0]!;client.clientSecretHash=await sha256Text("takosumi-oidc-client:secret-hosted");delete client.clientSecret;
  const grant=await f.grant();expect((await f.introspect(grant.access_token)).active).toBe(true);
  const discovery=await (await f.handler(new Request(`${issuer}/.well-known/openid-configuration`))).json() as {scopes_supported:string[];claims_supported:string[];token_endpoint_auth_methods_supported:string[];end_session_endpoint?:string};
  expect(discovery.scopes_supported).toEqual(["openid","email","profile","offline_access"]);expect(discovery.token_endpoint_auth_methods_supported).toEqual(["client_secret_basic"]);
  expect(discovery.claims_supported).toContain("auth_time");expect(discovery.claims_supported).toContain("sid");expect(discovery.claims_supported).not.toContain("takosumi");expect(discovery.end_session_endpoint).toBeUndefined();
});

test("ordinary same-browser A to B rotation retains only the non-replayable session anchor and explicit logout fences every linked grant",async()=>{
  const f=await fixture();const grant=await f.grant();const initial=(await f.store.findAccountSession(f.session.sessionId))!;
  expect(initial.issuerSessionId).toBe(await hostedIssuerSessionId(f.session.sessionId));
  const other="tsub_second_login";await f.store.saveAccount({subject:other,createdAt:Date.now(),updatedAt:Date.now()});
  const next=await rotateAccountSession({store:f.store,subject:other,oldSessionId:f.session.sessionId,now:Date.now(),ttlMs:60_000,hostedPolicy:true});
  const current=(await f.store.findAccountSession(next.sessionId))!;expect(next.sessionId).not.toBe(f.session.sessionId);expect(current.subject).toBe(other);expect(current.issuerSessionId).toBe(initial.issuerSessionId);expect(current.reauthenticatedAt).toBeUndefined();
  expect(current.issuerSessionId).not.toBe(next.sessionId);expect(current.issuerSessionId).not.toBe(await hostedIssuerSessionId(next.sessionId));expect(await f.store.findAccountSession(f.session.sessionId)).toBeUndefined();
  expect((await f.introspect(grant.access_token)).active).toBe(true);
  const logout=await handleHostedGlobalLogout({request:new Request(`${issuer}/api/v1/account/session/global-logout`,{method:"POST",headers:{origin:issuer,cookie:`${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${next.sessionId}`}}),store:f.store,issuer});expect(logout.status).toBe(204);
  expect(await f.store.isHostedOidcSessionHashRevoked!(initial.issuerSessionId!)).toBe(true);expect(await f.introspect(grant.access_token)).toEqual({active:false});
});

test("ordinary issuer session DELETE invalidates the shared anchor and rotated descendants without a public cookie ID",async()=>{
  const f=await fixture();const grant=await f.grant();const first=(await f.store.findAccountSession(f.session.sessionId))!;
  const next=await rotateAccountSession({store:f.store,subject,oldSessionId:f.session.sessionId,now:Date.now(),ttlMs:60_000,hostedPolicy:true});
  const request=new Request(`${issuer}/api/v1/account/session/me`,{method:"DELETE",headers:{origin:issuer,cookie:`${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${next.sessionId}`}});
  const deleted=await handleAccountSessionMeDelete({request,store:f.store,secureCookie:true,hostedPolicy:true});expect(deleted.status).toBe(204);expect(await f.store.isHostedOidcSessionHashRevoked!(first.issuerSessionId!)).toBe(true);expect(await f.introspect(grant.access_token)).toEqual({active:false});
  const fresh=await rotateAccountSession({store:f.store,subject,oldSessionId:next.sessionId,now:Date.now(),ttlMs:60_000,hostedPolicy:true});expect((await f.store.findAccountSession(fresh.sessionId))!.issuerSessionId).not.toBe(first.issuerSessionId);
});

test("logout using a stale cookie after a lost rotation response resolves its durable hash anchor and rejects the current session",async()=>{
  const f=await fixture();const first=(await f.store.findAccountSession(f.session.sessionId))!;
  const second=await rotateAccountSession({store:f.store,subject,oldSessionId:f.session.sessionId,now:Date.now(),ttlMs:60_000,hostedPolicy:true});
  const third=await rotateAccountSession({store:f.store,subject,oldSessionId:second.sessionId,now:Date.now(),ttlMs:60_000,hostedPolicy:true});
  expect(await f.store.findAccountSession(second.sessionId)).toBeUndefined();expect(await f.store.findHostedAccountSessionAnchor!(second.sessionId)).toBe(first.issuerSessionId);
  const staleRequest=new Request(`${issuer}/api/v1/account/session/global-logout`,{method:"POST",headers:{origin:issuer,cookie:`${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${second.sessionId}`}});
  expect((await handleHostedGlobalLogout({request:staleRequest,store:f.store,issuer})).status).toBe(204);
  expect(await f.store.isHostedOidcSessionHashRevoked!(first.issuerSessionId!)).toBe(true);
  expect((await requireAccountSession({request:new Request(`${issuer}/api/v1/account/session/me`,{headers:{cookie:`${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${third.sessionId}`}}),store:f.store})).ok).toBe(false);
});

test("an authentication security generation change starts a new issuer anchor rather than carrying old proof custody",async()=>{
  const f=await fixture();const prior=(await f.store.findAccountSession(f.session.sessionId))!;
  f.store.getAccountAuthenticationGeneration=()=>1;
  const rotated=await rotateAccountSession({store:f.store,subject,oldSessionId:f.session.sessionId,now:Date.now(),ttlMs:60_000,hostedPolicy:true});const current=(await f.store.findAccountSession(rotated.sessionId))!;
  expect(current.identityGeneration).toBe(1);expect(current.issuerSessionId).not.toBe(prior.issuerSessionId);
});

test("D1 rotation retains hash-only anchor custody after expired session removal; unknown logout is mutation-free",async()=>{
  const db=new SqliteFakeD1();const store=new D1AccountsStore(db as unknown as D1Database,{sessionHashSalt:"isolated-anchor-proof-salt"});const f=await fixture(store);const grant=await f.grant();
  const first=(await store.findAccountSession(f.session.sessionId))!;
  const next=await rotateAccountSession({store,subject,oldSessionId:f.session.sessionId,now:Date.now(),ttlMs:60_000,hostedPolicy:true});const record=(await store.findAccountSession(next.sessionId))!;
  expect(record.issuerSessionId).toBe(first.issuerSessionId);await store.saveAccountSession({...record,expiresAt:Date.now()-1});
  const request=(sessionId:string)=>new Request(`${issuer}/api/v1/account/session/global-logout`,{method:"POST",headers:{origin:issuer,cookie:`${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`}});
  expect((await requireAccountSession({request:request(next.sessionId),store})).ok).toBe(false);expect(await store.findAccountSession(next.sessionId)).toBeUndefined();
  expect(await store.findHostedAccountSessionAnchor!(next.sessionId)).toBe(first.issuerSessionId);expect((await handleHostedGlobalLogout({request:request(next.sessionId),store,issuer})).status).toBe(204);expect(await f.introspect(grant.access_token)).toEqual({active:false});
  const before=await db.prepare("SELECT count(*) AS n FROM takosumi_accounts_documents").first<{n:number}>();
  expect((await handleHostedGlobalLogout({request:request("sess_h_unknown_cookie"),store,issuer})).status).toBe(204);
  expect((await db.prepare("SELECT count(*) AS n FROM takosumi_accounts_documents").first<{n:number}>())!.n).toBe(before!.n);
  const rows=await db.prepare("SELECT key,document FROM takosumi_accounts_documents").all<{key:string;document:string}>();const persisted=JSON.stringify(rows.results);
  expect(persisted).not.toContain(f.session.sessionId);expect(persisted).not.toContain(next.sessionId);
});
