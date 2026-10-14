/// <reference path="../../../worker/src/cloudflare-workers-rpc.d.ts" />
import { WorkerEntrypoint } from "cloudflare:workers";
import { authStagingOwnerBundle, verifyAuthStagingOwnerSchema, type AuthStagingEnv } from "./staging-owner-bundle.ts";
import { assertAuthStagingVariables } from "./staging-target.ts";
import type { OwnerOperationAdmission } from "../../../accounts/service/src/owner-operation-contract.ts";

/** Private service-binding capability only. No fetch handler, caller identity
 * argument, binding props, subject lookup or public HTTP forwarding surface. */
export class AccountsOwnerAdmission extends WorkerEntrypoint<AuthStagingEnv> {
  async readOwnerOperation(input: unknown): Promise<OwnerOperationAdmission | undefined> {
    try {
      assertAuthStagingVariables(this.env);
      const bundle = authStagingOwnerBundle(this.env);
      if (!bundle.ports.ownerOperationTarget) return undefined;
      await verifyAuthStagingOwnerSchema(this.env);
      return await bundle.ownerOperationReader.readOwnerOperation(input);
    } catch {
      return undefined;
    }
  }
}
