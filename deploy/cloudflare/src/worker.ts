import {
  type CloudflareWorkerHandler,
  createCloudflareWorker,
} from "./handler.ts";
export { TakosumiOpenTofuRunner } from "./opentofu_runner_container.ts";
export { TakosCoordinationObject } from "./coordination_object.ts";

const worker: CloudflareWorkerHandler = createCloudflareWorker();

export default worker;
