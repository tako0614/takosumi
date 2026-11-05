import { expect, test } from "bun:test";
import { runNativePostgresDockerCommand } from "../../../helpers/deploy-control/native_postgres_restart.ts";

test("slow Docker run acknowledgement keeps the same dispatched client alive", async () => {
  const containerId = "a".repeat(64);
  let expireThirtySeconds = () => { throw new Error("command was not dispatched"); };
  let acknowledge = () => { throw new Error("command was not dispatched"); };
  let commands = 0;
  let clientKilled = false;
  let settled = false;
  const result = runNativePostgresDockerCommand(["run", "--detach", "--name", "owned-fixture"],
    async (_args, options) => {
      commands += 1;
      return await new Promise<{ stdout: string }>((resolve, reject) => {
        expireThirtySeconds = () => {
          if (options.timeout !== undefined && options.timeout <= 30_000) {
            clientKilled = true;
            reject(Object.assign(new Error("client deadline before daemon ACK"), {
              code: "ETIMEDOUT", killed: true, signal: "SIGTERM",
            }));
          }
        };
        acknowledge = () => resolve({ stdout: `${containerId}\n` });
      });
    }).then(
      (value) => { settled = true; return { status: "succeeded", value } as const; },
      (error: unknown) => { settled = true; return { status: "failed", error } as const; },
    );
  try {
    // Model the real failure ordering without a 30-second wall-clock wait:
    // the CLI deadline arrives before Docker's create acknowledgement.
    expireThirtySeconds();
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(clientKilled).toBe(false);
    acknowledge();
    expect(await result).toEqual({ status: "succeeded", value: containerId });
    expect(commands).toBe(1);
  } finally {
    acknowledge();
    await result;
  }
});
