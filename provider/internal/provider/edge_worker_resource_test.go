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
