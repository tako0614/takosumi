import { expect, test } from "bun:test";
import { main } from "../../../cli/src/main.ts";

test("retired FormAvailability CLI command is not registered", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["form-availability", "list"], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  expect(code).toBe(2);
  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toContain("Unknown command");
});
