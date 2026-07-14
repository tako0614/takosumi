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

func TestServiceShapePlansDoNotStartRemotePreviews(t *testing.T) {
	resources := []frameworkresource.Resource{
		NewObjectBucketResource(),
		NewKVStoreResource(),
		NewQueueResource(),
		NewSQLDatabaseResource(),
		NewContainerServiceResource(),
	}
	for _, candidate := range resources {
		if _, ok := candidate.(frameworkresource.ResourceWithModifyPlan); ok {
			t.Fatalf("%T must not start a discarded remote preview during OpenTofu planning", candidate)
		}
	}
}

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

func TestServiceShapeCreatePutsEachResourceOnce(t *testing.T) {
	tests := []struct {
		name     string
		kind     string
		spec     serviceShapeSpecKind
		resource any
	}{
		{
			name: "object bucket",
			kind: client.KindObjectBucket,
			spec: specObjectBucket,
			resource: objectBucketModel{
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
			},
		},
		{
			name: "kv store",
			kind: client.KindKVStore,
			spec: specKVStore,
			resource: kvStoreModel{
				ID:                     types.StringUnknown(),
				Name:                   types.StringValue("cache"),
				Consistency:            types.StringNull(),
				Space:                  types.StringNull(),
				TargetPool:             types.StringNull(),
				SelectedImplementation: types.StringUnknown(),
				Target:                 types.StringUnknown(),
				Locked:                 types.BoolUnknown(),
				Portability:            types.StringUnknown(),
				Outputs:                types.MapUnknown(types.StringType),
			},
		},
		{
			name: "queue",
			kind: client.KindQueue,
			spec: specQueue,
			resource: queueModel{
				ID:                     types.StringUnknown(),
				Name:                   types.StringValue("delivery"),
				MaxRetries:             types.Int64Null(),
				MaxBatchSize:           types.Int64Null(),
				Space:                  types.StringNull(),
				TargetPool:             types.StringNull(),
				SelectedImplementation: types.StringUnknown(),
				Target:                 types.StringUnknown(),
				Locked:                 types.BoolUnknown(),
				Portability:            types.StringUnknown(),
				Outputs:                types.MapUnknown(types.StringType),
			},
		},
		{
			name: "sql database",
			kind: client.KindSQLDatabase,
			spec: specSQLDatabase,
			resource: sqlDatabaseModel{
				ID:                     types.StringUnknown(),
				Name:                   types.StringValue("main"),
				Engine:                 types.StringNull(),
				MigrationsPath:         types.StringNull(),
				Space:                  types.StringNull(),
				TargetPool:             types.StringNull(),
				SelectedImplementation: types.StringUnknown(),
				Target:                 types.StringUnknown(),
				Locked:                 types.BoolUnknown(),
				Portability:            types.StringUnknown(),
				Outputs:                types.MapUnknown(types.StringType),
			},
		},
		{
			name: "container service",
			kind: client.KindContainerService,
			spec: specContainerService,
			resource: containerServiceModel{
				ID:                     types.StringUnknown(),
				Name:                   types.StringValue("agent"),
				Image:                  types.StringValue("ghcr.io/example/agent:1.0.0"),
				Ports:                  types.SetNull(types.Int64Type),
				PublicHTTP:             types.BoolNull(),
				Environment:            types.MapNull(types.StringType),
				Connections:            types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}),
				Space:                  types.StringNull(),
				TargetPool:             types.StringNull(),
				SelectedImplementation: types.StringUnknown(),
				Target:                 types.StringUnknown(),
				Locked:                 types.BoolUnknown(),
				Portability:            types.StringUnknown(),
				Outputs:                types.MapUnknown(types.StringType),
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			putCount := 0
			previewCount := 0
			var gotName string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var got client.Resource
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Errorf("decode request: %v", err)
				}
				gotName, _ = got.Spec["name"].(string)
				if r.Method == http.MethodPost && r.URL.Path == "/v1/resources/preview" {
					previewCount++
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(client.PreviewResourceResult{
						Resource:              got,
						PlanDigest:            "sha256:plan",
						SpecDigest:            "sha256:spec",
						ResolutionFingerprint: "sha256:resolution",
					})
					return
				}
				if r.Method != http.MethodPut {
					t.Errorf("expected PUT, got %s", r.Method)
				}
				putCount++
				wantPath := "/v1/resources/" + tt.kind + "/" + gotName
				if r.URL.Path != wantPath {
					t.Errorf("unexpected path %q, want %q", r.URL.Path, wantPath)
				}
				if got.Kind != tt.kind {
					t.Errorf("expected kind %q, got %q", tt.kind, got.Kind)
				}
				if got.Metadata.ManagedBy != client.ManagedByOpenTofu {
					t.Errorf("expected managedBy=opentofu, got %q", got.Metadata.ManagedBy)
				}
				if gotName == "" {
					t.Errorf("expected spec.name to be set, got %#v", got.Spec["name"])
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(client.Resource{
					APIVersion: client.APIVersion,
					Kind:       tt.kind,
					Metadata: client.Metadata{
						Name:  gotName,
						Space: "prod",
					},
					Spec: got.Spec,
					Status: &client.Status{
						Phase: "Ready",
						Resolution: client.Resolution{
							SelectedImplementation: "test_implementation",
							Target:                 "test-target",
							Locked:                 true,
							Portability:            "portable",
						},
						Outputs: map[string]any{"name": gotName},
					},
				})
			}))
			defer srv.Close()

			r := &serviceShapeResource{
				data: &providerData{
					client:       client.New(srv.URL, "", srv.Client()),
					defaultSpace: "prod",
					capabilities: client.ProductCapabilities{
						Resources: map[string]bool{tt.kind: true},
					},
				},
				cfg: serviceShapeConfig{
					kind: tt.kind,
					spec: tt.spec,
				},
			}
			var schemaResp frameworkresource.SchemaResponse
			r.Schema(ctx, frameworkresource.SchemaRequest{}, &schemaResp)
			if schemaResp.Diagnostics.HasError() {
				t.Fatalf("schema diagnostics: %v", schemaResp.Diagnostics)
			}
			plan := tfsdk.Plan{Schema: schemaResp.Schema}
			diags := plan.Set(ctx, tt.resource)
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
			if previewCount != 1 {
				t.Fatalf("expected exactly one preview during create, got %d", previewCount)
			}
		})
	}
}

func TestContainerServiceToResourceCarriesConnections(t *testing.T) {
	model := containerServiceModel{
		Name:        types.StringValue("agent"),
		Image:       types.StringValue("ghcr.io/example/agent:1.0.0"),
		PublicHTTP:  types.BoolValue(false),
		Environment: types.MapNull(types.StringType),
		Connections: testConnectionList(
			t,
			"JOBS",
			"Queue/jobs",
			[]string{"consume", "publish"},
			"env",
		),
	}

	resource, _, diags := model.toServiceShapeModel().toResource(
		context.Background(),
		"prod",
		client.KindContainerService,
		specContainerService,
	)
	if diags.HasError() {
		t.Fatalf("toResource diagnostics: %v", diags)
	}
	connections, ok := resource.Spec["connections"].(map[string]any)
	if !ok {
		t.Fatalf("expected connections to be carried, got %#v", resource.Spec["connections"])
	}
	jobs, ok := connections["JOBS"].(map[string]any)
	if !ok || jobs["resource"] != "Queue/jobs" || jobs["projection"] != "env" {
		t.Fatalf("expected JOBS connection to be carried, got %#v", connections)
	}
}
