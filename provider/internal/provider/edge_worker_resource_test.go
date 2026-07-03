package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
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

func TestEdgeWorkerCreateAcceptsEndpointDefinedProfileTokens(t *testing.T) {
	ctx := context.Background()
	var gotProfiles []any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/v1/resources/EdgeWorker/api" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var req client.Resource
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		rawProfiles, ok := req.Spec["profiles"].([]any)
		if !ok {
			t.Errorf("expected profiles list in request, got %#v", req.Spec["profiles"])
		}
		gotProfiles = rawProfiles
		req.Status = &client.Status{
			Phase: "Ready",
			Resolution: client.Resolution{
				SelectedImplementation: "custom_worker_runtime",
				Target:                 "operator-runtime",
				Locked:                 true,
				Portability:            "portable",
			},
			Outputs: map[string]any{"url": "https://api.example.com"},
		}
		raw, _ := json.Marshal(req)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	defer srv.Close()

	r := &edgeWorkerResource{
		data: &providerData{
			client:       client.New(srv.URL, "", srv.Client()),
			defaultSpace: "prod",
			capabilities: client.ProductCapabilities{
				Resources: map[string]bool{client.KindEdgeWorker: true},
			},
		},
	}
	var schemaResp frameworkresource.SchemaResponse
	r.Schema(ctx, frameworkresource.SchemaRequest{}, &schemaResp)
	if schemaResp.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics: %v", schemaResp.Diagnostics)
	}
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	diags := plan.Set(ctx, edgeWorkerModel{
		ID:                 types.StringUnknown(),
		Name:               types.StringValue("api"),
		ArtifactPath:       types.StringValue("/work/dist/worker.js"),
		CompatibilityFlags: types.SetNull(types.StringType),
		Profiles: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("runtime.workers.next"),
			types.StringValue("bindings.custom"),
		}),
		Space:                  types.StringNull(),
		TargetPool:             types.StringNull(),
		SelectedImplementation: types.StringUnknown(),
		Target:                 types.StringUnknown(),
		Locked:                 types.BoolUnknown(),
		Portability:            types.StringUnknown(),
		Outputs:                types.MapUnknown(types.StringType),
	})
	if diags.HasError() {
		t.Fatalf("plan diagnostics: %v", diags)
	}
	resp := frameworkresource.CreateResponse{
		State: tfsdk.State{Schema: schemaResp.Schema},
	}
	r.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("create diagnostics: %v", resp.Diagnostics)
	}
	if len(gotProfiles) != 2 {
		t.Fatalf("expected two profile tokens, got %#v", gotProfiles)
	}
	want := map[string]bool{
		"runtime.workers.next": true,
		"bindings.custom":      true,
	}
	for _, got := range gotProfiles {
		value, ok := got.(string)
		if !ok || !want[value] {
			t.Fatalf("unexpected profile token %#v in %#v", got, gotProfiles)
		}
		delete(want, value)
	}
	if len(want) != 0 {
		t.Fatalf("missing profile tokens: %#v", want)
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
