export * from "./src/worker.ts";
export * from "./src/worker.generated.ts";

import { WorkerKind } from "./src/worker.ts";
import { WORKER_KIND_NAME, WORKER_KIND_URI } from "./src/worker.generated.ts";

export const KIND_NAME = WORKER_KIND_NAME;
export const KIND_URI = WORKER_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
});
export const KIND_DESCRIPTOR = WorkerKind;
