import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  declaredResourcesFromPlanJson,
  missingReconcileCandidates,
  reconcileApplyWorkspaceState,
  reconcileImportId,
  reconcileStateFromPlanJson,
  recordedAddressesFromPlanJson,
  statefulActionAddressesFromPlanJson,
} from "../../runner/lib/state_reconcile.ts";
import type { CommandContext } from "../../runner/lib/types.ts";

function resource(address: string, values: Record<string, unknown> = {}) {
  return {
    address,
    values: { name: address.split(".").pop(), ...values },
  };
}

function planJsonFixture(input: {
  readonly planned?: readonly unknown[];
  readonly prior?: readonly unknown[];
  readonly changes?: readonly unknown[];
  readonly childModules?: readonly unknown[];
  readonly priorChildModules?: readonly unknown[];
}): string {
  return JSON.stringify({
    planned_values: {
      root_module: {
        resources: input.planned ?? [],
        ...(input.childModules ? { child_modules: input.childModules } : {}),
      },
    },
    prior_state: {
      values: {
        root_module: {
          resources: input.prior ?? [],
          ...(input.priorChildModules
            ? { child_modules: input.priorChildModules }
            : {}),
        },
      },
    },
    ...(input.changes ? { resource_changes: input.changes } : {}),
  });
}

test("declared resources walk nested child modules and split unresolvable names", () => {
  const planJson = planJsonFixture({
    planned: [resource("res.a")],
    childModules: [
      {
        address: "module.child",
        resources: [
          resource("module.child.res.b", { space: "tenant:t1" }),
          { address: "module.child.res.c", values: {} },
        ],
        child_modules: [
          {
            address: "module.child.module.grand",
            resources: [resource("module.child.module.grand.res.d")],
          },
        ],
      },
    ],
  });
  const declared = declaredResourcesFromPlanJson(planJson);
  expect(declared.candidates.map((c) => c.address)).toEqual([
    "res.a",
    "module.child.res.b",
    "module.child.module.grand.res.d",
  ]);
  expect(declared.unresolvable).toEqual(["module.child.res.c"]);
  expect(declared.candidates[1]).toEqual({
    address: "module.child.res.b",
    name: "b",
    space: "tenant:t1",
  });
});

test("missing candidates subtract prior state addresses exactly", () => {
  const planJson = planJsonFixture({
    planned: [resource("res.a"), resource("res.b"), resource("res.c")],
    prior: [resource("res.a")],
  });
  const missing = missingReconcileCandidates(planJson);
  expect(missing.candidates.map((c) => c.address)).toEqual([
    "res.b",
    "res.c",
  ]);
  expect(missing.declaredAddresses).toBe(3);
  expect(missing.recordedAddresses).toBe(1);
});

test("stateful action addresses exclude pure creates", () => {
  const planJson = planJsonFixture({
    changes: [
      { address: "res.new", change: { actions: ["create"] } },
      { address: "res.upd", change: { actions: ["update"] } },
      { address: "res.del", change: { actions: ["delete"] } },
      { address: "res.rep", change: { actions: ["delete", "create"] } },
      { address: "res.noop", change: { actions: ["no-op"] } },
    ],
  });
  expect([...statefulActionAddressesFromPlanJson(planJson)].sort()).toEqual([
    "res.del",
    "res.noop",
    "res.rep",
    "res.upd",
  ]);
});

test("import id uses the space-qualified form only when space resolves", () => {
  expect(
    reconcileImportId({ address: "a", name: "n", space: "tenant:t1" }),
  ).toBe("tenant:t1/n");
  expect(reconcileImportId({ address: "a", name: "n" })).toBe("n");
});

test("recorded addresses come only from prior state", () => {
  const planJson = planJsonFixture({
    planned: [resource("res.a"), resource("res.b")],
    prior: [resource("res.b")],
  });
  expect([...recordedAddressesFromPlanJson(planJson)]).toEqual(["res.b"]);
});

const cleanupPaths: string[] = [];

const originalPath = Bun.env.PATH;

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
  if (originalPath === undefined) delete Bun.env.PATH;
  else Bun.env.PATH = originalPath;
});

interface FakeTofu {
  readonly context: CommandContext;
  readonly logPath: string;
  readonly root: string;
  readonly moduleDir: string;
}

/**
 * Installs a `tofu` shim on the context PATH. The shim logs every invocation,
 * serves `state list` from FAKE_STATE_LIST, serves `show -json` per plan path,
 * imports successfully except for addresses in `absentImports` (answered with
 * the OpenTofu remote-object-missing diagnostic) or `failingImports`.
 */
async function fakeTofu(options: {
  readonly stateList?: string;
  readonly savedPlanJson?: string;
  readonly enumeratePlanJson?: string;
  readonly absentImports?: readonly string[];
  readonly failingImports?: readonly string[];
}): Promise<FakeTofu> {
  const root = await mkdtemp(join(tmpdir(), "reconcile-tofu-"));
  const moduleDir = join(root, "module");
  cleanupPaths.push(root);
  await mkdir(moduleDir, { recursive: true });
  const logPath = join(root, "calls.log");
  const savedPath = join(root, "saved.json");
  const enumPath = join(root, "enum.json");
  await writeFile(savedPath, options.savedPlanJson ?? "{}");
  await writeFile(enumPath, options.enumeratePlanJson ?? "{}");
  const script = [
    "#!/bin/sh",
    "echo \"$@\" >> " + logPath,
    "case \"$1\" in",
    "  state) printf \"%s\\n\" \"$FAKE_STATE_LIST\" ;;",
    "  plan) ;;",
    "  show)",
    "    case \"$3\" in",
    "      *tfreconcile*) cat " + enumPath + " ;;",
    "      *) cat " + savedPath + " ;;",
    "    esac;;",
    "  import)",
    "    addr=\"\"",
    "    for last in \"$@\"; do prev=\"$addr\"; addr=\"$last\"; done",
    "    case \"$prev\" in",
    ...(options.absentImports ?? []).map(
      (a) => "      " + a + ") echo \"Cannot import non-existent remote object\" >&2; exit 1 ;;",
    ),
    ...(options.failingImports ?? []).map(
      (a) => "      " + a + ") echo \"provider exploded\" >&2; exit 1 ;;",
    ),
    "    esac;;",
    "esac",
  ].join("\n");
  await writeFile(join(root, "tofu"), script);
  await chmod(join(root, "tofu"), 0o755);
  // Bun.spawn resolves the executable through the process PATH, not the child
  // env, so the shim directory must be prepended to Bun.env.PATH itself.
  Bun.env.PATH = root + ":" + (originalPath ?? "");
  return {
    context: {
      env: {
        PATH: Bun.env.PATH ?? "",
        FAKE_STATE_LIST: options.stateList ?? "",
      },
    },
    logPath,
    root,
    moduleDir,
  };
}

test("reconcile imports only missing addresses and tolerates host absence", async () => {
  const planJson = planJsonFixture({
    planned: [
      resource("res.kept"),
      resource("res.stray"),
      resource("res.ghost"),
    ],
    prior: [resource("res.kept")],
  });
  const tofu = await fakeTofu({ absentImports: ["res.ghost"] });
  const summary = await reconcileStateFromPlanJson({
    planJson,
    moduleDir: tofu.moduleDir,
    context: tofu.context,
    workspaceRoot: tofu.root,
  });
  expect(summary.status).toBe("reconciled");
  expect(summary.imported).toEqual(["res.stray"]);
  expect(summary.absent).toEqual(["res.ghost"]);
  const log = await readFile(tofu.logPath, "utf8");
  expect(log).toContain("res.stray");
  expect(log).toContain("res.ghost");
  expect(log).not.toContain("res.kept");
});

test("reconcile records real import failures without aborting", async () => {
  const planJson = planJsonFixture({
    planned: [resource("res.kept"), resource("res.bad")],
    prior: [resource("res.kept")],
  });
  const tofu = await fakeTofu({ failingImports: ["res.bad"] });
  const summary = await reconcileStateFromPlanJson({
    planJson,
    moduleDir: tofu.moduleDir,
    context: tofu.context,
    workspaceRoot: tofu.root,
  });
  expect(summary.imported).toEqual([]);
  expect(summary.skipped).toEqual([
    { address: "res.bad", reason: "import_failed" },
  ]);
});

test("apply-workspace reconcile short-circuits when every stateful action is recorded", async () => {
  const savedPlan = planJsonFixture({
    changes: [
      { address: "res.a", change: { actions: ["update"] } },
      { address: "res.b", change: { actions: ["create"] } },
    ],
  });
  const tofu = await fakeTofu({
    stateList: "res.a",
    savedPlanJson: savedPlan,
  });
  const summary = await reconcileApplyWorkspaceState({
    moduleDir: tofu.moduleDir,
    planPath: join(tofu.root, "tfplan"),
    context: tofu.context,
    workspaceRoot: tofu.root,
    enumeratePlanPath: join(tofu.root, "tfreconcile.plan"),
  });
  expect(summary).toBeUndefined();
  const log = await readFile(tofu.logPath, "utf8");
  expect(log).not.toMatch(/^plan /mu);
  expect(log).not.toMatch(/^import /mu);
});

test("apply-workspace reconcile imports strays the reviewed plan expects in state", async () => {
  const savedPlan = planJsonFixture({
    changes: [
      { address: "res.a", change: { actions: ["delete"] } },
      { address: "res.stray", change: { actions: ["delete"] } },
    ],
  });
  const enumeration = planJsonFixture({
    planned: [resource("res.a"), resource("res.stray")],
    prior: [resource("res.a")],
  });
  const tofu = await fakeTofu({
    stateList: "res.a",
    savedPlanJson: savedPlan,
    enumeratePlanJson: enumeration,
  });
  const summary = await reconcileApplyWorkspaceState({
    moduleDir: tofu.moduleDir,
    planPath: join(tofu.root, "tfplan"),
    context: tofu.context,
    workspaceRoot: tofu.root,
    enumeratePlanPath: join(tofu.root, "tfreconcile.plan"),
  });
  expect(summary?.status).toBe("reconciled");
  expect(summary?.imported).toEqual(["res.stray"]);
  const log = await readFile(tofu.logPath, "utf8");
  expect(log).toContain("import -input=false -no-color res.stray stray");
});

test("a first apply whose saved plan is all creates needs no reconcile calls", async () => {
  const savedPlan = planJsonFixture({
    changes: [
      { address: "res.a", change: { actions: ["create"] } },
      { address: "res.b", change: { actions: ["create"] } },
    ],
  });
  const tofu = await fakeTofu({ savedPlanJson: savedPlan });
  const summary = await reconcileApplyWorkspaceState({
    moduleDir: tofu.moduleDir,
    planPath: join(tofu.root, "tfplan"),
    context: tofu.context,
    workspaceRoot: tofu.root,
    enumeratePlanPath: join(tofu.root, "tfreconcile.plan"),
  });
  expect(summary).toBeUndefined();
});
