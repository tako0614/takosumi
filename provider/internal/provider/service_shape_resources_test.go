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
		NewVectorIndexResource(),
		NewDurableWorkflowResource(),
		NewStatefulActorNamespaceResource(),
		NewScheduleResource(),
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
				StorageClass:           types.StringValue("standard"),
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
		{
			name: "vector index",
			kind: client.KindVectorIndex,
			spec: specVectorIndex,
			resource: vectorIndexModel{
				ID: types.StringUnknown(), Name: types.StringValue("embeddings"),
				Dimensions: types.Int64Value(1536), Metric: types.StringNull(),
				Connections: types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}),
				Space:       types.StringNull(), TargetPool: types.StringNull(),
				SelectedImplementation: types.StringUnknown(), Target: types.StringUnknown(),
				Locked: types.BoolUnknown(), Portability: types.StringUnknown(), Outputs: types.MapUnknown(types.StringType),
			},
		},
		{
			name: "durable workflow",
			kind: client.KindDurableWorkflow,
			spec: specDurableWorkflow,
			resource: durableWorkflowModel{
				ID: types.StringUnknown(), Name: types.StringValue("ingest"),
				ArtifactPath: types.StringValue("/work/workflow.js"), ArtifactURL: types.StringNull(),
				ArtifactRef: types.StringNull(), ArtifactSHA256: types.StringNull(),
				Entrypoint: types.StringValue("IngestWorkflow"), MaxAttempts: types.Int64Null(),
				InitialBackoffSeconds: types.Int64Null(),
				Connections:           types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}),
				Space:                 types.StringNull(), TargetPool: types.StringNull(),
				SelectedImplementation: types.StringUnknown(), Target: types.StringUnknown(),
				Locked: types.BoolUnknown(), Portability: types.StringUnknown(), Outputs: types.MapUnknown(types.StringType),
			},
		},
		{
			name: "stateful actor namespace",
			kind: client.KindStatefulActorNamespace,
			spec: specStatefulActorNamespace,
			resource: statefulActorNamespaceModel{
				ID: types.StringUnknown(), Name: types.StringValue("rooms"),
				ClassName: types.StringValue("RoomActor"), StorageProfile: types.StringNull(),
				MigrationTag: types.StringNull(),
				Connections:  types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes}),
				Space:        types.StringNull(), TargetPool: types.StringNull(),
				SelectedImplementation: types.StringUnknown(), Target: types.StringUnknown(),
				Locked: types.BoolUnknown(), Portability: types.StringUnknown(), Outputs: types.MapUnknown(types.StringType),
			},
		},
		{
			name: "schedule",
			kind: client.KindSchedule,
			spec: specSchedule,
			resource: scheduleModel{
				ID: types.StringUnknown(), Name: types.StringValue("nightly"),
				Cron: types.StringValue("0 0 * * *"), Timezone: types.StringNull(),
				Connections: testConnectionList(t, "workflow", "DurableWorkflow/ingest", []string{"invoke"}, "schedule_trigger"),
				Space:       types.StringNull(), TargetPool: types.StringNull(),
				SelectedImplementation: types.StringUnknown(), Target: types.StringUnknown(),
				Locked: types.BoolUnknown(), Portability: types.StringUnknown(), Outputs: types.MapUnknown(types.StringType),
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

func TestObjectBucketStorageClassDefaultsAndMapsToWireSpec(t *testing.T) {
	for _, tt := range []struct {
		name  string
		value types.String
		want  string
	}{
		{name: "omitted", value: types.StringNull(), want: "standard"},
		{name: "standard", value: types.StringValue("standard"), want: "standard"},
		{name: "infrequent access", value: types.StringValue("infrequent_access"), want: "infrequent_access"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			model := serviceShapeModel{
				Name:         types.StringValue("assets"),
				StorageClass: tt.value,
				Interfaces:   types.SetNull(types.StringType),
			}
			resource, _, diags := model.toResource(
				context.Background(),
				"prod",
				client.KindObjectBucket,
				specObjectBucket,
			)
			if diags.HasError() {
				t.Fatalf("toResource diagnostics: %v", diags)
			}
			if got := resource.Spec["storageClass"]; got != tt.want {
				t.Fatalf("expected storageClass %q, got %#v", tt.want, got)
			}
		})
	}
}

func TestRefreshObjectBucketSpecDefaultsLegacyStorageClass(t *testing.T) {
	m := serviceShapeModel{StorageClass: types.StringValue("infrequent_access")}
	res := &client.Resource{
		Metadata: client.Metadata{Name: "assets", Space: "prod"},
		Spec:     map[string]any{"name": "assets"},
	}
	diags := refreshServiceShapeSpec(
		context.Background(),
		res,
		specObjectBucket,
		&m,
	)
	if diags.HasError() {
		t.Fatalf("refresh diagnostics: %v", diags)
	}
	if got := m.StorageClass.ValueString(); got != "standard" {
		t.Fatalf("expected legacy ObjectBucket to refresh as standard, got %q", got)
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

func TestNewServiceShapesRejectInvalidSpecsBeforeRemoteCalls(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name  string
		model serviceShapeModel
		kind  string
		spec  serviceShapeSpecKind
	}{
		{
			name: "object bucket storage class", kind: client.KindObjectBucket, spec: specObjectBucket,
			model: serviceShapeModel{Name: types.StringValue("bad"), StorageClass: types.StringValue("provider-tier")},
		},
		{
			name: "vector dimensions", kind: client.KindVectorIndex, spec: specVectorIndex,
			model: serviceShapeModel{Name: types.StringValue("bad"), Dimensions: types.Int64Value(0)},
		},
		{
			name: "workflow digest", kind: client.KindDurableWorkflow, spec: specDurableWorkflow,
			model: serviceShapeModel{
				Name: types.StringValue("bad"), ArtifactURL: types.StringValue("https://example.test/workflow.js"),
				ArtifactPath: types.StringNull(), ArtifactRef: types.StringNull(), ArtifactSHA256: types.StringValue("not-a-digest"),
				Entrypoint: types.StringValue("Workflow"),
			},
		},
		{
			name: "actor class", kind: client.KindStatefulActorNamespace, spec: specStatefulActorNamespace,
			model: serviceShapeModel{Name: types.StringValue("bad"), ClassName: types.StringValue("Room Actor")},
		},
		{
			name: "schedule target", kind: client.KindSchedule, spec: specSchedule,
			model: serviceShapeModel{
				Name: types.StringValue("bad"), Cron: types.StringValue("60 0 * * *"),
				Connections: testConnectionList(t, "workflow", "DurableWorkflow/ingest", []string{"invoke"}, "schedule_trigger"),
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, diags := tt.model.toResource(ctx, "prod", tt.kind, tt.spec)
			if !diags.HasError() {
				t.Fatalf("expected local shape validation diagnostics")
			}
		})
	}
}

func TestNewServiceShapeImportObserveRefreshesTypedStateAndOutputs(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name     string
		kind     string
		specKind serviceShapeSpecKind
		spec     map[string]any
		assert   func(*testing.T, serviceShapeModel)
	}{
		{
			name: "vector", kind: client.KindVectorIndex, specKind: specVectorIndex,
			spec: map[string]any{"name": "embeddings", "dimensions": float64(1536), "metric": "cosine"},
			assert: func(t *testing.T, m serviceShapeModel) {
				if m.Dimensions.ValueInt64() != 1536 || m.Metric.ValueString() != "cosine" {
					t.Fatalf("vector spec not refreshed: %#v", m)
				}
			},
		},
		{
			name: "workflow", kind: client.KindDurableWorkflow, specKind: specDurableWorkflow,
			spec: map[string]any{
				"name": "ingest", "source": map[string]any{"artifactRef": "artifact:v1", "artifactSha256": "sha256:abc"},
				"entrypoint": "IngestWorkflow", "retry": map[string]any{"maxAttempts": float64(5), "initialBackoffSeconds": float64(10)},
			},
			assert: func(t *testing.T, m serviceShapeModel) {
				if m.ArtifactRef.ValueString() != "artifact:v1" || m.MaxAttempts.ValueInt64() != 5 || m.InitialBackoffSeconds.ValueInt64() != 10 {
					t.Fatalf("workflow spec not refreshed: %#v", m)
				}
			},
		},
		{
			name: "actor namespace", kind: client.KindStatefulActorNamespace, specKind: specStatefulActorNamespace,
			spec: map[string]any{"name": "rooms", "className": "RoomActor", "storageProfile": "durable_sqlite", "migrationTag": "v1"},
			assert: func(t *testing.T, m serviceShapeModel) {
				if m.ClassName.ValueString() != "RoomActor" || m.StorageProfile.ValueString() != "durable_sqlite" || m.MigrationTag.ValueString() != "v1" {
					t.Fatalf("actor namespace spec not refreshed: %#v", m)
				}
			},
		},
		{
			name: "schedule", kind: client.KindSchedule, specKind: specSchedule,
			spec: map[string]any{
				"name": "nightly", "cron": "0 0 * * *", "timezone": "UTC",
				"connections": map[string]any{"workflow": map[string]any{
					"resource": "DurableWorkflow/ingest", "permissions": []any{"invoke"}, "projection": "schedule_trigger",
				}},
			},
			assert: func(t *testing.T, m serviceShapeModel) {
				if m.Cron.ValueString() != "0 0 * * *" || m.Timezone.ValueString() != "UTC" || m.Connections.IsNull() {
					t.Fatalf("schedule spec not refreshed: %#v", m)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost {
					t.Errorf("expected observe POST, got %s", r.Method)
				}
				_ = json.NewEncoder(w).Encode(client.Resource{
					APIVersion: client.APIVersion, Kind: tt.kind,
					Metadata: client.Metadata{Name: tt.spec["name"].(string), Space: "prod"},
					Spec:     tt.spec,
					Status: &client.Status{Resolution: client.Resolution{
						SelectedImplementation: "operator.test", Target: "target-a", Locked: true, Portability: "portable",
					}, Outputs: map[string]any{"endpoint": "https://service.example.test"}},
				})
			}))
			defer srv.Close()

			shape := &serviceShapeResource{
				data: &providerData{
					client: client.New(srv.URL, "", srv.Client()), defaultSpace: "prod",
					capabilities: client.ProductCapabilities{Resources: map[string]bool{tt.kind: true}},
				},
				cfg: serviceShapeConfig{kind: tt.kind, spec: tt.specKind},
			}
			var schemaResp frameworkresource.SchemaResponse
			shape.Schema(ctx, frameworkresource.SchemaRequest{}, &schemaResp)
			importState := tfsdk.State{Schema: schemaResp.Schema}
			if diags := importState.Set(ctx, nullServiceShapeImportModel(tt.specKind)); diags.HasError() {
				t.Fatalf("initialize import state: %v", diags)
			}
			importResp := frameworkresource.ImportStateResponse{State: importState}
			shape.ImportState(ctx, frameworkresource.ImportStateRequest{ID: "prod/" + tt.spec["name"].(string)}, &importResp)
			if importResp.Diagnostics.HasError() {
				t.Fatalf("import diagnostics: %v", importResp.Diagnostics)
			}
			readResp := frameworkresource.ReadResponse{State: importResp.State}
			shape.Read(ctx, frameworkresource.ReadRequest{State: importResp.State}, &readResp)
			if readResp.Diagnostics.HasError() {
				t.Fatalf("read diagnostics: %v", readResp.Diagnostics)
			}
			model, diags := shape.modelFromState(ctx, readResp.State)
			if diags.HasError() {
				t.Fatalf("state diagnostics: %v", diags)
			}
			tt.assert(t, model)
			outputs := map[string]string{}
			if d := model.Outputs.ElementsAs(ctx, &outputs, false); d.HasError() {
				t.Fatalf("outputs diagnostics: %v", d)
			}
			if outputs["endpoint"] != "https://service.example.test" {
				t.Fatalf("public outputs not refreshed: %#v", outputs)
			}
		})
	}
}

func nullServiceShapeImportModel(spec serviceShapeSpecKind) any {
	commonID := types.StringNull()
	commonName := types.StringNull()
	commonSpace := types.StringNull()
	commonTargetPool := types.StringNull()
	commonSelected := types.StringNull()
	commonTarget := types.StringNull()
	commonLocked := types.BoolNull()
	commonPortability := types.StringNull()
	commonOutputs := types.MapNull(types.StringType)
	nullConnections := types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes})
	switch spec {
	case specVectorIndex:
		return vectorIndexModel{
			ID: commonID, Name: commonName, Dimensions: types.Int64Null(), Metric: types.StringNull(), Connections: nullConnections,
			Space: commonSpace, TargetPool: commonTargetPool, SelectedImplementation: commonSelected,
			Target: commonTarget, Locked: commonLocked, Portability: commonPortability, Outputs: commonOutputs,
		}
	case specDurableWorkflow:
		return durableWorkflowModel{
			ID: commonID, Name: commonName, ArtifactPath: types.StringNull(), ArtifactURL: types.StringNull(),
			ArtifactRef: types.StringNull(), ArtifactSHA256: types.StringNull(), Entrypoint: types.StringNull(),
			MaxAttempts: types.Int64Null(), InitialBackoffSeconds: types.Int64Null(), Connections: nullConnections,
			Space: commonSpace, TargetPool: commonTargetPool, SelectedImplementation: commonSelected,
			Target: commonTarget, Locked: commonLocked, Portability: commonPortability, Outputs: commonOutputs,
		}
	case specStatefulActorNamespace:
		return statefulActorNamespaceModel{
			ID: commonID, Name: commonName, ClassName: types.StringNull(), StorageProfile: types.StringNull(),
			MigrationTag: types.StringNull(), Connections: nullConnections, Space: commonSpace,
			TargetPool: commonTargetPool, SelectedImplementation: commonSelected, Target: commonTarget,
			Locked: commonLocked, Portability: commonPortability, Outputs: commonOutputs,
		}
	case specSchedule:
		return scheduleModel{
			ID: commonID, Name: commonName, Cron: types.StringNull(), Timezone: types.StringNull(),
			Connections: nullConnections, Space: commonSpace, TargetPool: commonTargetPool,
			SelectedImplementation: commonSelected, Target: commonTarget, Locked: commonLocked,
			Portability: commonPortability, Outputs: commonOutputs,
		}
	default:
		panic("unsupported import test shape")
	}
}
