package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

func TestServiceShapeToResourceCarriesTargetPoolName(t *testing.T) {
	model := serviceShapeModel{
		Name:       types.StringValue("assets"),
		TargetPool: types.StringValue("storage"),
	}

	resource, space, diags := model.toResource(
		context.Background(),
		"prod",
		"ObjectBucket",
		specObjectBucket,
	)
	if diags.HasError() {
		t.Fatalf("toResource diagnostics: %v", diags)
	}
	if space != "prod" {
		t.Fatalf("expected prod space, got %q", space)
	}
	if resource.TargetPoolName != "storage" {
		t.Fatalf("expected targetPoolName to be carried, got %#v", resource)
	}
}

func TestServiceShapeCreatePutsResourceOnce(t *testing.T) {
	ctx := context.Background()
	putCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("expected PUT, got %s", r.Method)
		}
		if r.URL.Path != "/v1/resources/ObjectBucket/assets" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		putCount++
		var got client.Resource
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if got.Metadata.ManagedBy != client.ManagedByOpenTofu {
			t.Errorf("expected managedBy=opentofu, got %q", got.Metadata.ManagedBy)
		}
		if got.Spec["name"] != "assets" {
			t.Errorf("expected spec.name=assets, got %#v", got.Spec["name"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(client.Resource{
			APIVersion: client.APIVersion,
			Kind:       client.KindObjectBucket,
			Metadata: client.Metadata{
				Name:  "assets",
				Space: "prod",
			},
			Spec: got.Spec,
			Status: &client.Status{
				Phase: "Ready",
				Resolution: client.Resolution{
					SelectedImplementation: "cloudflare_r2_bucket",
					Target:                 "cloudflare-main",
					Locked:                 true,
					Portability:            "mostly_portable",
				},
				Outputs: map[string]any{"bucket_name": "assets"},
			},
		})
	}))
	defer srv.Close()

	r := &serviceShapeResource{
		data: &providerData{
			client:       client.New(srv.URL, "", srv.Client()),
			defaultSpace: "prod",
			capabilities: client.ProductCapabilities{
				Resources: map[string]bool{client.KindObjectBucket: true},
			},
		},
		cfg: serviceShapeConfig{
			kind: client.KindObjectBucket,
			spec: specObjectBucket,
		},
	}
	var schemaResp frameworkresource.SchemaResponse
	r.Schema(ctx, frameworkresource.SchemaRequest{}, &schemaResp)
	if schemaResp.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics: %v", schemaResp.Diagnostics)
	}
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	diags := plan.Set(ctx, objectBucketModel{
		ID:                     types.StringUnknown(),
		Name:                   types.StringValue("assets"),
		Interfaces:             types.SetNull(types.StringType),
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
	if putCount != 1 {
		t.Fatalf("expected exactly one PUT during create, got %d", putCount)
	}
}
