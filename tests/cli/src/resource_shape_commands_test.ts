import { expect, test } from "bun:test";
import { main } from "../../../cli/src/main.ts";

test("retired Resource Shape CLI domains are not normal commands", async () => {
  for (const args of [
    ["resources"],
    ["resources", "list"],
    ["target-pools"],
    ["target-pools", "list"],
    ["space-policies"],
    ["space-policies", "list"],
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

test("CLI help does not advertise retired Resource Shape domains", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await main(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(0);
  expect(stderr).toEqual([]);
  const help = stdout.join("\n");
  expect(help).not.toContain("resources");
  expect(help).not.toContain("target-pools");
  expect(help).not.toContain("space-policies");
});
