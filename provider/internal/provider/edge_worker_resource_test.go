package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

func TestRefreshEdgeWorkerSpecClearsAbsentOptionalFields(t *testing.T) {
	m := edgeWorkerModel{
		Name:              types.StringValue("api"),
		ArtifactPath:      types.StringValue("/old/dist/worker.js"),
		ArtifactURL:       types.StringValue("https://example.com/old-worker.js"),
		ArtifactSHA256:    types.StringValue("sha256:old"),
		CompatibilityDate: types.StringValue("2026-06-29"),
		CompatibilityFlags: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("nodejs_compat"),
		}),
		Profiles: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("workers_bindings"),
		}),
	}
	res := &client.Resource{
		Metadata: client.Metadata{Name: "api", Space: "prod"},
		Spec: map[string]any{
			"name": "api",
		},
	}

	diags := refreshEdgeWorkerSpec(res, &m)
	if diags.HasError() {
		t.Fatalf("refreshEdgeWorkerSpec diagnostics: %v", diags)
	}
	if !m.ArtifactPath.IsNull() {
		t.Fatalf("expected artifact_path to be cleared, got %q", m.ArtifactPath.ValueString())
	}
	if !m.ArtifactURL.IsNull() {
		t.Fatalf("expected artifact_url to be cleared, got %q", m.ArtifactURL.ValueString())
	}
	if !m.ArtifactSHA256.IsNull() {
		t.Fatalf("expected artifact_sha256 to be cleared, got %q", m.ArtifactSHA256.ValueString())
	}
	if !m.CompatibilityDate.IsNull() {
		t.Fatalf("expected compatibility_date to be cleared, got %q", m.CompatibilityDate.ValueString())
	}
	if !m.CompatibilityFlags.IsNull() {
		t.Fatalf("expected compatibility_flags to be cleared")
	}
	if !m.Profiles.IsNull() {
		t.Fatalf("expected profiles to be cleared")
	}
}

func TestEdgeWorkerToResourceCarriesTargetPoolName(t *testing.T) {
	model := edgeWorkerModel{
		Name:         types.StringValue("api"),
		ArtifactPath: types.StringValue("/work/dist/worker.js"),
		TargetPool:   types.StringValue("containers"),
	}

	resource, space, diags := model.toResource(context.Background(), "prod")
	if diags.HasError() {
		t.Fatalf("toResource diagnostics: %v", diags)
	}
	if space != "prod" {
		t.Fatalf("expected prod space, got %q", space)
	}
	if resource.TargetPoolName != "containers" {
		t.Fatalf("expected targetPoolName to be carried, got %#v", resource)
	}
}

func TestEdgeWorkerToResourceAcceptsArtifactURLWithDigest(t *testing.T) {
	model := edgeWorkerModel{
		Name:           types.StringValue("api"),
		ArtifactURL:    types.StringValue("https://example.com/releases/api-worker.js"),
		ArtifactSHA256: types.StringValue("sha256:1111111111111111111111111111111111111111111111111111111111111111"),
	}

	resource, _, diags := model.toResource(context.Background(), "prod")
	if diags.HasError() {
		t.Fatalf("toResource diagnostics: %v", diags)
	}
	source, ok := resource.Spec["source"].(map[string]any)
	if !ok {
		t.Fatalf("expected source map, got %#v", resource.Spec["source"])
	}
	if source["artifactUrl"] != "https://example.com/releases/api-worker.js" {
		t.Fatalf("expected artifactUrl to be carried, got %#v", source)
	}
	if source["artifactSha256"] != "sha256:1111111111111111111111111111111111111111111111111111111111111111" {
		t.Fatalf("expected artifactSha256 to be carried, got %#v", source)
	}
}

func TestEdgeWorkerToResourceRejectsInvalidArtifactSources(t *testing.T) {
	cases := []edgeWorkerModel{
		{Name: types.StringValue("api")},
		{
			Name:         types.StringValue("api"),
			ArtifactPath: types.StringValue("/work/dist/worker.js"),
			ArtifactURL:  types.StringValue("https://example.com/releases/api-worker.js"),
		},
		{
			Name:        types.StringValue("api"),
			ArtifactURL: types.StringValue("https://example.com/releases/api-worker.js"),
		},
		{
			Name:           types.StringValue("api"),
			ArtifactURL:    types.StringValue("http://example.com/releases/api-worker.js"),
			ArtifactSHA256: types.StringValue("1111111111111111111111111111111111111111111111111111111111111111"),
		},
	}
	for _, model := range cases {
		_, _, diags := model.toResource(context.Background(), "prod")
		if !diags.HasError() {
			t.Fatalf("expected diagnostics for %#v", model)
		}
	}
}
