import { expect, test } from "bun:test";
import { analyzeOpenTofuCapsuleFiles, collectRootModuleOutputDeclarations, collectRootModuleVariableDeclarations } from "../../../../core/domains/sources/capsule_compatibility.ts";
import type { SourceSnapshot } from "takosumi-contract/sources";

const snapshot: SourceSnapshot = {
  id: "snap_hcl_budget", sourceId: "src_hcl_budget", url: "https://source.example.test/repo.git",
  ref: "main", resolvedCommit: "19287f25ae7bc57eb518974e4f2f17af633834db", path: ".",
  archiveRef: "synthetic/source.tar.zst", archiveDigest: "sha256:synthetic", archiveSizeBytes: 1,
  fetchedByRunId: "run_hcl_budget", fetchedAt: "2026-11-12T00:00:00.000Z",
};

function analyze(text: string, path = "main.tf") {
  return analyzeOpenTofuCapsuleFiles({ sourceId: snapshot.sourceId, sourceSnapshot: snapshot, files: [{ path, text }] });
}

function objectDepth(depth: number): string {
  return `locals { value = ${"{ child = ".repeat(depth - 1)}true${" }".repeat(depth - 1)} }\noutput "value" { value = local.value }\n`;
}

function expectBudgetRefusal(text: string) {
  expect(new TextEncoder().encode(text).byteLength).toBeLessThan(8 * 1024);
  const result = analyze(text);
  expect(result.level).toBe("unsupported");
  expect(result.findings).toContainEqual(expect.objectContaining({ code: "hcl_block_scan_budget_exceeded", compatibilityImpact: "unsupported", path: "main.tf" }));
  expect(result.resources).toEqual([]);
  return result;
}

test("keeps ordinary resources and valid nested object/block metadata", () => {
  const result = analyze(`resource "aws_s3_bucket" "a" {
    bucket = "fixture"
    lifecycle { prevent_destroy = true }
    tags = { Environment = "test" }
  }
  output "bucket" { value = aws_s3_bucket.a.bucket }`);
  expect(result.level).toBe("ready");
  expect(result.resources).toEqual([{ type: "aws_s3_bucket", count: 1, allowed: true }]);
  expect(result.findings).toEqual([]);
});

test("accepts the exact structural HCL nesting limit", () => {
  expect(analyze(objectDepth(256)).level).toBe("ready");
});

test("refuses one structural level above the fixed HCL budget", () => {
  expectBudgetRefusal(objectDepth(257));
});

test("refuses a small unclosed nested named-block fixture before extracting resources", () => {
  const result = expectBudgetRefusal('resource "x" "y" {\n'.repeat(257) + "}");
  expect(result.findings).toContainEqual(expect.objectContaining({ code: "opentofu_configuration_hcl_incomplete", compatibilityImpact: "unsupported" }));
});

test("quoted braces are data outside the structural depth budget", () => {
  const text = "{".repeat(300) + "}".repeat(300);
  const result = analyze(`resource "aws_s3_bucket" "a" { bucket = "fixture" tags = { note = ${JSON.stringify(text)} } }\noutput "bucket" { value = aws_s3_bucket.a.bucket }`);
  expect(result.level).toBe("ready");
  expect(result.resources).toEqual([{ type: "aws_s3_bucket", count: 1, allowed: true }]);
});

test("comments and heredoc data do not consume the structural depth budget", () => {
  const braces = "{".repeat(300);
  const result = analyze(`locals {
    # ${braces}
    value = <<-TEXT
${braces}
TEXT
  }
  output "value" { value = local.value }`);
  expect(result.level).toBe("ready");
});

{
  const braces = "{".repeat(300) + "}".repeat(300);
  const bodies = [["marker prefix", `prefix\nTEXT is data\n${braces}\n`], ["empty body", ""]] as const;
  for (const [label, body] of bodies) {
    test(`heredoc retains the real following blocks: ${label}`, () => {
      const result = analyze(`locals { value = <<-TEXT\n${body}TEXT\n}\nresource "terraform_data" "a" {}\noutput "value" { value = local.value }`);
      expect(result.level).toBe("ready");
      expect(result.resources).toEqual([{ type: "terraform_data", count: 1, allowed: true }]);
      expect(result.rootModuleOutputs).toEqual([{ name: "value", sensitive: false, ephemeral: false }]);
    });
  }
}

test("preserves the existing unsupported JSON semantics boundary", () => {
  const result = analyze(JSON.stringify({ resource: { aws_s3_bucket: { a: { bucket: "fixture" } } }, output: { bucket: { value: "\${aws_s3_bucket.a.bucket}" } } }), "main.tf.json");
  expect(result.level).toBe("unsupported");
  expect(result.resources).toEqual([]);
  expect(result.findings).toContainEqual(expect.objectContaining({ code: "opentofu_json_semantics_unsupported", compatibilityImpact: "unsupported" }));
});

test("standalone root declaration readers retain the structural work bound", () => {
  const files = [{ path: "main.tf", text: objectDepth(257) }];
  expect(() => collectRootModuleOutputDeclarations(files)).toThrow("HCL block nesting exceeds");
  expect(() => collectRootModuleVariableDeclarations(files)).toThrow("HCL block nesting exceeds");
});

test("quoted interpolation strings keep literal braces outside the block budget", () => {
  const literal = "{".repeat(300) + "}".repeat(300);
  const result = analyze(`resource "aws_s3_bucket" "a" { bucket = "\${format("%s", "${literal}")}" }\noutput "bucket" { value = aws_s3_bucket.a.bucket }`);
  expect(result.level).toBe("ready");
  expect(result.resources).toEqual([{ type: "aws_s3_bucket", count: 1, allowed: true }]);
});

{
  const literal = JSON.stringify("{".repeat(300) + "}".repeat(300));
  const values = [
    ["nested interpolation", '"${format("%s", "${format("%s", ' + literal + ')}")}"'],
    ["directive", '"%{ if ' + literal + ' != "" }fixture%{ endif }"'],
    ["escaped markers", '"$${' + "{".repeat(300) + ' %%{' + "}".repeat(300) + ' \\"fixture\\""'],
  ] as const;
  for (const [label, value] of values) {
    test(`template forms preserve the following block: ${label}`, () => {
      const result = analyze(`locals { value = ${value} }\nresource "aws_s3_bucket" "a" { bucket = "fixture" }\noutput "value" { value = local.value }`);
      expect(result.findings.map(finding => finding.code)).toEqual([]);
      expect(result.level).toBe("ready");
      expect(result.resources).toEqual([{ type: "aws_s3_bucket", count: 1, allowed: true }]);
      expect(result.rootModuleOutputs).toEqual([{ name: "value", sensitive: false, ephemeral: false }]);
    });
  }
}

test("preserves the existing incomplete-template diagnostics for comment-like interpolation data", () => {
  const literal = JSON.stringify("{".repeat(300) + "}".repeat(300));
  const value = '"${format("http://%s", ' + literal + ')}"';
  const result = analyze(`locals { value = ${value} }\nresource "aws_s3_bucket" "a" { bucket = "fixture" }\noutput "value" { value = local.value }`);
  expect(result.level).toBe("unsupported");
  expect(result.findings.map(finding => finding.code)).toEqual([
    "opentofu_configuration_hcl_incomplete", "required_providers_missing",
  ]);
});
