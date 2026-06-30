// Resource Shape domain barrel (`takosumi.dev/v1alpha1`, Flow B).
//
// Durable SQL/D1 store implementations live in sibling modules and are wired by
// the composition root; they are not re-exported here to keep this barrel free
// of storage-driver imports.

export * from "./records.ts";
export * from "./stores.ts";
export * from "./adapter.ts";
export * from "./backing_capsule.ts";
export * from "./resolver.ts";
export * from "./planner.ts";
export * from "./service.ts";
