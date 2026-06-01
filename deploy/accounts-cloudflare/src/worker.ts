import {
  type CloudflareWorkerHandler,
  createCloudflareWorker,
} from "./handler.ts";

const worker: CloudflareWorkerHandler = createCloudflareWorker();

export default worker;
