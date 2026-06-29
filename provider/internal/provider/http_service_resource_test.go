package provider

import (
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

func TestRefreshHttpServiceSpecClearsAbsentOptionalFields(t *testing.T) {
	m := httpServiceModel{
		Name:             types.StringValue("api"),
		RuntimeInterface: types.StringValue("web_fetch"),
		ArtifactPath:     types.StringValue("/old/dist/worker.js"),
		PublicHTTP:       types.BoolValue(true),
	}
	res := &client.Resource{
		Metadata: client.Metadata{Name: "api", Space: "prod"},
		Spec: map[string]any{
			"name": "api",
			"runtime": map[string]any{
				"interface": "web_fetch",
			},
		},
	}

	diags := refreshHttpServiceSpec(res, &m)
	if diags.HasError() {
		t.Fatalf("refreshHttpServiceSpec diagnostics: %v", diags)
	}
	if !m.ArtifactPath.IsNull() {
		t.Fatalf("expected artifact_path to be cleared, got %q", m.ArtifactPath.ValueString())
	}
	if !m.PublicHTTP.IsNull() {
		t.Fatalf("expected public_http to be cleared, got %v", m.PublicHTTP.ValueBool())
	}
}
