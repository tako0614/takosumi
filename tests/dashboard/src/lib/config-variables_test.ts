/**
 * Config-editor write semantics (service detail 設定値 form).
 *
 * The load-bearing invariant is DIRTY-ONLY writes: a no-edit save must write
 * NOTHING. The previous implementation seeded store-declared rows from
 * `variables[name] ?? defaultValue ?? ""` and wrote every named row on save,
 * so a no-edit save pinned listing defaults as explicit values, wrote
 * untouched optional fields as "", untouched booleans as false and empty JSON
 * as null — all overriding the module's HCL defaults on the next deploy.
 */
import { describe, expect, test } from "bun:test";
import {
  buildConfigVariablePatch,
  type ConfigVariableRow,
  configRowsFromInstallConfig,
} from "../../../../dashboard/src/lib/capsules-ui.ts";
import type { InstallConfig } from "../../../../dashboard/src/lib/control-api.ts";

interface TestInput {
  readonly name: string;
  readonly type?: "string" | "number" | "boolean" | "json";
  readonly required?: boolean;
  readonly advanced?: boolean;
  readonly secret?: boolean;
  readonly defaultValue?: string;
}

function makeConfig(options: {
  readonly variableMapping?: Record<string, unknown>;
  readonly inputs?: readonly TestInput[];
}): InstallConfig {
  return {
    id: "cfg_1",
    name: "app",
    sourceKind: "first_party_capsule",
    trustLevel: "official",
    variableMapping: options.variableMapping ?? {},
    outputAllowlist: {},
    store: {
      order: 1,
      surface: "service",
      kind: "worker",
      provider: "cloudflare",
      suggestedName: "app",
      badge: { ja: "追加候補", en: "Installable" },
      name: { ja: "App", en: "App" },
      description: { ja: "アプリ", en: "App" },
      inputs: (options.inputs ?? []).map((input) => ({
        label: { ja: input.name, en: input.name },
        ...input,
      })),
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as unknown as InstallConfig;
}

function patchOf(rows: readonly ConfigVariableRow[]): {
  readonly variableMapping: Readonly<Record<string, unknown>>;
  readonly removeVariables: readonly string[];
} {
  const patch = buildConfigVariablePatch(rows);
  if ("error" in patch) throw new Error(`unexpected error: ${patch.error}`);
  return patch;
}

/** Simulate the view's editVariable (user edit → dirty, cancels リセット). */
function edit(
  rows: readonly ConfigVariableRow[],
  id: string,
  patch: Partial<ConfigVariableRow>,
): ConfigVariableRow[] {
  return rows.map((row) =>
    row.id === id
      ? { ...row, ...patch, dirty: true, resetToDefault: false }
      : row,
  );
}

describe("configRowsFromInstallConfig", () => {
  test("seeds store rows with the presented default and tracks mapping presence", () => {
    const rows = configRowsFromInstallConfig(
      makeConfig({
        variableMapping: { public_subdomain: "mine" },
        inputs: [
          { name: "public_subdomain", defaultValue: "blog" },
          { name: "optional_note" },
        ],
      }),
      "ja",
    );
    const pinned = rows.find((row) => row.name === "public_subdomain")!;
    expect(pinned.value).toBe("mine");
    expect(pinned.hasExistingValue).toBe(true);
    expect(pinned.savedValue).toBe("mine");
    expect(pinned.defaultText).toBe("blog");
    expect(pinned.dirty).toBe(false);
    const optional = rows.find((row) => row.name === "optional_note")!;
    expect(optional.value).toBe("");
    expect(optional.hasExistingValue).toBe(false);
  });

  test("masks secret store values but keeps mapping presence", () => {
    const rows = configRowsFromInstallConfig(
      makeConfig({
        variableMapping: { admin_password: "hunter2" },
        inputs: [{ name: "admin_password", secret: true }],
      }),
      "ja",
    );
    const secret = rows.find((row) => row.name === "admin_password")!;
    expect(secret.value).toBe("");
    expect(secret.secret).toBe(true);
    expect(secret.hasExistingValue).toBe(true);
  });
});

describe("buildConfigVariablePatch — dirty-only writes", () => {
  const config = makeConfig({
    variableMapping: { public_url: "https://x.test", public_subdomain: "mine" },
    inputs: [
      { name: "public_subdomain", defaultValue: "blog" },
      { name: "optional_note" },
      { name: "enable_thing", type: "boolean" },
      { name: "extra_json", type: "json" },
      { name: "replica_count", type: "number", defaultValue: "2" },
    ],
  });
  const seed = () => [...configRowsFromInstallConfig(config, "ja")];

  test('a no-edit save writes NOTHING (no defaults, no "", no false, no null)', () => {
    const patch = patchOf(seed());
    expect(patch.variableMapping).toEqual({});
    expect(patch.removeVariables).toEqual([]);
  });

  test("edited rows are written with their parsed type", () => {
    let rows = seed();
    const bool = rows.find((row) => row.name === "enable_thing")!;
    const json = rows.find((row) => row.name === "extra_json")!;
    const num = rows.find((row) => row.name === "replica_count")!;
    rows = edit(rows, bool.id, { value: "true" });
    rows = edit(rows, json.id, { value: '{"a":1}' });
    rows = edit(rows, num.id, { value: "3" });
    const patch = patchOf(rows);
    expect(patch.variableMapping).toEqual({
      enable_thing: true,
      extra_json: { a: 1 },
      replica_count: 3,
    });
    expect(patch.removeVariables).toEqual([]);
  });

  test("untouched pre-existing mapping values are not rewritten (merge patch keeps them)", () => {
    let rows = seed();
    const note = rows.find((row) => row.name === "optional_note")!;
    rows = edit(rows, note.id, { value: "hello" });
    const patch = patchOf(rows);
    // public_subdomain ("mine") and the custom public_url row stay untouched:
    // neither written nor removed — the PATCH merge semantics preserve them.
    expect(patch.variableMapping).toEqual({ optional_note: "hello" });
    expect(patch.removeVariables).toEqual([]);
  });

  test("リセット on a pre-existing store row removes the pinned value on save", () => {
    const rows = seed().map((row) =>
      row.name === "public_subdomain"
        ? {
            ...row,
            value: row.defaultText,
            dirty: false,
            resetToDefault: row.hasExistingValue,
          }
        : row,
    );
    const patch = patchOf(rows);
    expect(patch.variableMapping).toEqual({});
    expect(patch.removeVariables).toEqual(["public_subdomain"]);
  });

  test("リセット on an absent-from-mapping store row is a no-op on save", () => {
    const rows = seed().map((row) =>
      row.name === "optional_note"
        ? {
            ...row,
            value: row.defaultText,
            dirty: false,
            resetToDefault: row.hasExistingValue,
          }
        : row,
    );
    const patch = patchOf(rows);
    expect(patch.variableMapping).toEqual({});
    expect(patch.removeVariables).toEqual([]);
  });

  test("editing after リセット cancels the pending removal and writes the value", () => {
    let rows = seed().map((row) =>
      row.name === "public_subdomain"
        ? { ...row, value: row.defaultText, dirty: false, resetToDefault: true }
        : row,
    );
    const target = rows.find((row) => row.name === "public_subdomain")!;
    rows = edit(rows, target.id, { value: "fresh" });
    const patch = patchOf(rows);
    expect(patch.variableMapping).toEqual({ public_subdomain: "fresh" });
    expect(patch.removeVariables).toEqual([]);
  });

  test("deleting a free-form row removes its variable", () => {
    const rows = seed().map((row) =>
      row.name === "public_url" ? { ...row, deleted: true } : row,
    );
    const patch = patchOf(rows);
    expect(patch.variableMapping).toEqual({});
    expect(patch.removeVariables).toEqual(["public_url"]);
  });

  test("renaming a free-form row removes the old name and writes the new one", () => {
    let rows = seed();
    const custom = rows.find((row) => row.name === "public_url")!;
    rows = edit(rows, custom.id, { name: "site_url" });
    const patch = patchOf(rows);
    expect(patch.variableMapping).toEqual({ site_url: "https://x.test" });
    expect(patch.removeVariables).toEqual(["public_url"]);
  });

  test("a dirty secret row with an empty value keeps the stored secret", () => {
    const secretConfig = makeConfig({
      variableMapping: { admin_password: "hunter2" },
      inputs: [{ name: "admin_password", secret: true }],
    });
    let rows = [...configRowsFromInstallConfig(secretConfig, "ja")];
    const secret = rows.find((row) => row.name === "admin_password")!;
    rows = edit(rows, secret.id, { value: "" });
    const patch = patchOf(rows);
    expect(patch.variableMapping).toEqual({});
    expect(patch.removeVariables).toEqual([]);
  });

  test("duplicate names still error, including against untouched rows", () => {
    let rows = seed();
    const custom = rows.find((row) => row.name === "public_url")!;
    rows = edit(rows, custom.id, { name: "public_subdomain" });
    const patch = buildConfigVariablePatch(rows);
    expect("error" in patch).toBe(true);
  });

  test("invalid JSON on a dirty row errors instead of writing null", () => {
    let rows = seed();
    const json = rows.find((row) => row.name === "extra_json")!;
    rows = edit(rows, json.id, { value: "{not json" });
    const patch = buildConfigVariablePatch(rows);
    expect("error" in patch).toBe(true);
  });
});
