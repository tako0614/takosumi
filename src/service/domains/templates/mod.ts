/**
 * Built-in first-party Capsule module registry domain entry point.
 *
 * Composes the catalog registry (`registry.ts`) with input validation
 * (`validation.ts`). The deploy-control domain depends on this module to resolve
 * a template, validate request inputs, and feed rootgen.
 */

export { assertValidTemplate, validateTemplateInputs } from "./validation.ts";
export type { TemplateInputValue } from "./validation.ts";
export {
  defaultTemplateRegistry,
  TemplateRegistry,
} from "./registry.ts";
