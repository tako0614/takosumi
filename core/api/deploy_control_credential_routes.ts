/**
 * Credential Recipe discovery.
 *
 * Credential Recipes are guided setup helpers, never a provider allowlist. The
 * Recipes are optional setup metadata. They never select a runner or constrain
 * which valid OpenTofu provider source can execute.
 */

import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  PROVIDER_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_CREDENTIAL_RECIPE_ROUTE,
  TAKOSUMI_CREDENTIAL_RECIPES_ROUTE,
} from "./deploy_control_route_paths.ts";

export const DEPLOY_CONTROL_CREDENTIAL_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_CREDENTIAL_RECIPES_ROUTE,
      summary:
        "Lists built-in Credential Recipes used for optional guided setup.",
      auth: "deploy-control-token",
      operationId: "listCredentialRecipes",
      openapi: { okSchema: "ListCredentialRecipesResponse" },
      notImplementedMessage: "credential recipes not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_CREDENTIAL_RECIPE_ROUTE,
      summary: "Reads one built-in Credential Recipe.",
      auth: "deploy-control-token",
      operationId: "getCredentialRecipe",
      openapi: {
        pathParams: ["recipeId"],
        okSchema: "CredentialRecipeResponse",
      },
      notImplementedMessage: "credential recipes not wired",
    },
  ];

export function mountDeployControlCredentialRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, controller } = ctx;

  app.get(
    TAKOSUMI_CREDENTIAL_RECIPES_ROUTE,
    defineRoute({
      ctx,
      handler: async ({ c }) =>
        c.json(await controller.listCredentialRecipes(), 200),
    }),
  );

  app.get(
    TAKOSUMI_CREDENTIAL_RECIPE_ROUTE,
    defineRoute({
      ctx,
      param: { param: "recipeId", pattern: PROVIDER_ID_PATTERN },
      handler: async ({ c, id }) =>
        c.json(await controller.getCredentialRecipe(id), 200),
    }),
  );

}
