import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/new/InstallExecution.tsx",
  ),
  "utf8",
);

test("waiting approval exposes technical run details before approval", () => {
  const waitingApproval = source.match(
    /<Show when=\{current\(\)\.status === "waiting_approval"\}>([\s\S]*?)<\/Show>/,
  )?.[1];

  expect(waitingApproval).toBeDefined();
  expect(waitingApproval).toContain(
    "href={`/runs/${encodeURIComponent(current().id)}`}",
  );
  expect(waitingApproval).toContain('t("installStore.runDetails")');
  expect(waitingApproval).toContain('t("installStore.approve")');
});
