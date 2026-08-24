import { expect, test } from "bun:test";
import { main } from "../../../cli/src/main.ts";

test("retired Form Package CLI commands are not registered", async () => {
  for (const args of [
    ["form-packages"],
    ["form-packages", "install"],
    ["form-packages", "reverify"],
  ]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await main(args, {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    ).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Unknown command");
  }
});

test("CLI help does not advertise the retired Form Package lane", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await main(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("\n")).not.toContain("form-packages");
});
