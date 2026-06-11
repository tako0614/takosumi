import { expect, test } from "bun:test";
import {
  createDefaultRunnerProfiles,
  parseEnabledRunnerProfileIds,
  resolveEnabledRunnerProfiles,
} from "./mod.ts";

// resolveEnabledRunnerProfiles is the operator-curated provider surface: it maps
// the CSV TAKOSUMI_ENABLED_RUNNER_PROFILES knob onto the default seeds, enabling
// only the listed ids and excluding the rest entirely so an unlisted provider
// never appears in /v1/runner-profiles or policy evaluation.

const SEEDS = createDefaultRunnerProfiles(123);

function idsOf(profiles: readonly { id: string }[]): readonly string[] {
  return profiles.map((profile) => profile.id);
}

test("defaults to cloudflare-default when env value is unset", () => {
  const enabled = resolveEnabledRunnerProfiles(SEEDS, undefined);
  expect(idsOf(enabled)).toEqual(["cloudflare-default"]);
});

test("defaults to cloudflare-default when env value is empty or whitespace", () => {
  expect(idsOf(resolveEnabledRunnerProfiles(SEEDS, ""))).toEqual([
    "cloudflare-default",
  ]);
  expect(idsOf(resolveEnabledRunnerProfiles(SEEDS, "   "))).toEqual([
    "cloudflare-default",
  ]);
  expect(idsOf(resolveEnabledRunnerProfiles(SEEDS, " , ,"))).toEqual([
    "cloudflare-default",
  ]);
});

test("includes multiple listed profiles in env order and excludes the rest", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "cloudflare-default,aws-template,gcp-template",
  );
  expect(idsOf(enabled)).toEqual([
    "cloudflare-default",
    "aws-template",
    "gcp-template",
  ]);
  // Unlisted seeds are excluded entirely.
  expect(idsOf(enabled)).not.toContain("azure-template");
  expect(idsOf(enabled)).not.toContain("docker-custom-example");
});

test("trims whitespace and collapses duplicate ids (first wins)", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    " aws-template , cloudflare-default , aws-template ",
  );
  expect(idsOf(enabled)).toEqual(["aws-template", "cloudflare-default"]);
});

test("merges takosumi.com/profile-enabled=true into every enabled profile", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "cloudflare-default,aws-template",
  );
  const byId = new Map(enabled.map((profile) => [profile.id, profile]));
  // cloudflare-default carries no template-state label but still gets enabled.
  expect(
    byId.get("cloudflare-default")?.labels?.["takosumi.com/profile-enabled"],
  ).toEqual("true");
  // aws-template is a template seed; its template-state label is preserved and the
  // enabled label is merged on so the policy gate lets it pass.
  expect(
    byId.get("aws-template")?.labels?.["takosumi.com/profile-state"],
  ).toEqual("template");
  expect(
    byId.get("aws-template")?.labels?.["takosumi.com/profile-enabled"],
  ).toEqual("true");
});

test("does not mutate the input seed profiles", () => {
  const before = SEEDS.find((profile) => profile.id === "aws-template")!;
  resolveEnabledRunnerProfiles(SEEDS, "aws-template");
  expect(before.labels?.["takosumi.com/profile-enabled"]).toEqual(undefined);
});

test("skips unknown ids without throwing and keeps known ones", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "cloudflare-default,does-not-exist,aws-template",
  );
  expect(idsOf(enabled)).toEqual(["cloudflare-default", "aws-template"]);
});

test("returns an empty surface when every listed id is unknown", () => {
  const enabled = resolveEnabledRunnerProfiles(SEEDS, "nope,also-nope");
  expect(enabled).toEqual([]);
});

test("parseEnabledRunnerProfileIds normalizes CSV input", () => {
  expect(parseEnabledRunnerProfileIds(undefined)).toEqual([
    "cloudflare-default",
  ]);
  expect(parseEnabledRunnerProfileIds("")).toEqual(["cloudflare-default"]);
  expect(parseEnabledRunnerProfileIds("a, b ,a,,c")).toEqual(["a", "b", "c"]);
});
