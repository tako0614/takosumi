import { createEphemeralAccountsHandler, type AccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { rotateAccountSession } from "../../../../accounts/service/src/account-session.ts";

let initialized: Promise<{handler:AccountsHandler;cookie:string}> | undefined;
const issuer="https://issuer.example.test";

export default {
  async fetch(request:Request,env:{ACCOUNTS_TEST_DB:D1Database}):Promise<Response> {
    initialized ??= (async()=>{
      const store=new D1AccountsStore(env.ACCOUNTS_TEST_DB,{sessionHashSalt:"isolated-workerd-hosted-test-salt"});
      const now=Date.now();const subject="tsub_workerd_shared";
      await store.saveAccount({subject,createdAt:now,updatedAt:now});
      const session=await rotateAccountSession({store,subject,now,ttlMs:60_000,hostedPolicy:true,freshlyAuthenticatedAt:Math.floor(now/1000)});
      const handler=await createEphemeralAccountsHandler({issuer,store,hostedSessionPolicy:true,allowEphemeralKeyOnHttpsIssuer:true,clients:[{
        clientId:"hosted",profile:"shared-account",enabled:true,clientSecret:"workerd-test-secret",tokenEndpointAuthMethod:"client_secret_basic",redirectUris:["https://hosted.example.test/auth/callback"],allowedScopes:["openid","offline_access"],
      }]});
      return {handler,cookie:`__Host-takosumi_session=${session.sessionId}`};
    })();
    const {handler,cookie}=await initialized;
    // Test fixture only: synthetic account/session setup is never product code.
    if(new URL(request.url).pathname==="/__fixture/session") return Response.json({cookie});
    return await handler(request);
  },
};
