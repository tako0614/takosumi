import { registerTemplate, type Template } from "takosumi-contract";
import { SelfhostedSingleVmTemplate } from "./selfhosted-single-vm.ts";
import { WebAppOnCloudflareTemplate } from "./web-app-on-cloudflare.ts";

export { SelfhostedSingleVmTemplate, WebAppOnCloudflareTemplate };
export type { SelfhostedSingleVmInputs } from "./selfhosted-single-vm.ts";
export type { WebAppOnCloudflareInputs } from "./web-app-on-cloudflare.ts";

/**
 * Erases the per-template `Inputs` generic for storage in the bare
 * `Template`-keyed registry. `validateInputs` accepts `unknown` and `expand`
 * only ever receives values that have already passed validation, so the
 * widening to `Template = Template<JsonObject>` is safe at runtime.
 */
function asGenericTemplate<Inputs>(template: Template<Inputs>): Template {
  return template as Template;
}

export const TAKOSUMI_BUNDLED_TEMPLATES: readonly Template[] = [
  asGenericTemplate(SelfhostedSingleVmTemplate),
  asGenericTemplate(WebAppOnCloudflareTemplate),
];

export function registerTakosumiTemplates(): void {
  for (const template of TAKOSUMI_BUNDLED_TEMPLATES) {
    registerTemplate(template);
  }
}
