import {
  type CloudflareWorkerHandler,
  createCloudflareWorker,
} from "./handler.ts";
export { OpenTofuRunnerObject } from "./durable/OpenTofuRunnerObject.ts";
export { CoordinationObject } from "./durable/CoordinationObject.ts";

const worker: CloudflareWorkerHandler = createCloudflareWorker();

export default worker;
