import {
  type CloudflareWorkerHandler,
  createCloudflareWorker,
} from "./handler.ts";
export { OpenTofuRunnerObject } from "./durable/OpenTofuRunnerObject.ts";
export { CoordinationObject } from "./durable/CoordinationObject.ts";
export { OpenTofuRunOwnerObject } from "./durable/OpenTofuRunOwnerObject.ts";

const worker: CloudflareWorkerHandler = createCloudflareWorker();

export default worker;
