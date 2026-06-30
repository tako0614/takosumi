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

func TestPushNotificationToResourceCarriesProtocolsAndTTL(t *testing.T) {
	model := serviceShapeModel{
		Name: types.StringValue("push"),
		Protocols: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("web_push"),
			types.StringValue("fcm"),
		}),
		TTLSeconds: types.Int64Value(600),
	}

	resource, _, diags := model.toResource(
		context.Background(),
		"prod",
		client.KindPushNotification,
		specPushNotification,
	)
	if diags.HasError() {
		t.Fatalf("toResource diagnostics: %v", diags)
	}
	protocols, ok := resource.Spec["protocols"].([]string)
	if !ok {
		t.Fatalf("expected protocols []string, got %#v", resource.Spec["protocols"])
	}
	if len(protocols) != 2 || protocols[0] != "web_push" || protocols[1] != "fcm" {
		t.Fatalf("unexpected protocols %#v", protocols)
	}
	delivery, ok := resource.Spec["delivery"].(map[string]any)
	if !ok {
		t.Fatalf("expected delivery map, got %#v", resource.Spec["delivery"])
	}
	if delivery["ttlSeconds"] != int64(600) {
		t.Fatalf("expected ttlSeconds=600, got %#v", delivery["ttlSeconds"])
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
			name: "push notification",
			kind: client.KindPushNotification,
			spec: specPushNotification,
			resource: pushNotificationModel{
				ID:                     types.StringUnknown(),
				Name:                   types.StringValue("push"),
				Protocols:              types.SetNull(types.StringType),
				TTLSeconds:             types.Int64Null(),
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
			var gotName string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPut {
					t.Errorf("expected PUT, got %s", r.Method)
				}
				putCount++
				var got client.Resource
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Errorf("decode request: %v", err)
				}
				gotName, _ = got.Spec["name"].(string)
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
		})
	}
}
