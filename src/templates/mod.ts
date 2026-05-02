import { registerTemplate, type Template } from "takosumi-contract";
import { SelfhostedSingleVmTemplate } from "./selfhosted-single-vm.ts";
import { WebAppOnCloudflareTemplate } from "./web-app-on-cloudflare.ts";

export { SelfhostedSingleVmTemplate, WebAppOnCloudflareTemplate };
export type { SelfhostedSingleVmInputs } from "./selfhosted-single-vm.ts";
export type { WebAppOnCloudflareInputs } from "./web-app-on-cloudflare.ts";

export const TAKOSUMI_BUNDLED_TEMPLATES: readonly Template[] = [
  SelfhostedSingleVmTemplate as unknown as Template,
  WebAppOnCloudflareTemplate as unknown as Template,
];

export function registerTakosumiTemplates(): void {
  for (const template of TAKOSUMI_BUNDLED_TEMPLATES) {
    registerTemplate(template);
  }
}
