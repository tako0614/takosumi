import type { CapsuleInstallConfigReAdoptionInputContext } from "takosumi-contract";

export function reAdoptionContext(): {
  -readonly [Key in keyof CapsuleInstallConfigReAdoptionInputContext]: CapsuleInstallConfigReAdoptionInputContext[Key]
} {
  return {
    capsuleId: "capsule_a", revisionPlanId: "revision_failed", sourceId: "source_a",
    sourceSnapshotId: "snapshot_two", targetRef: "release/v2", resolvedCommit: "b".repeat(40), modulePath: ".",
    currentInstallConfigId: "config_current", currentStateGeneration: 4, currentStateVersionId: "state_four",
    authorityGuard: "fixture-current-guard", baseInstallConfigId: "generic_service",
    variables: [
      { name: "release_note", type: "string", required: true, sensitive: false, userEditable: true,
        label: { en: "Release note" }, currentValue: { status: "unset" } },
      { name: "optional_flag", type: "boolean", required: false, sensitive: false, userEditable: true,
        label: { en: "Optional flag" }, currentValue: { status: "present", value: false } },
      { name: "empty_value", type: "string", required: false, sensitive: false, userEditable: true,
        label: { en: "Empty value" }, currentValue: { status: "present", value: "" } },
      { name: "json_value", type: "json", required: false, sensitive: false, userEditable: true,
        label: { en: "JSON value" }, currentValue: { status: "present", value: null } },
    ],
  };
}
