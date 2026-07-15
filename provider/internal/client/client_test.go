package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func discoveryBody(resourceShapes bool) string {
	body := map[string]any{
		"api_versions": []string{APIVersion},
		"features": map[string]bool{
			"resource_shapes": resourceShapes,
			"oidc":            true,
			"compat_s3":       true,
		},
		"endpoints": map[string]string{
			"api":          "https://takosumi.example.com/api",
			"capabilities": "https://takosumi.example.com/v1/capabilities",
			"oidc_issuer":  "https://takosumi.example.com",
		},
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

func TestDiscover_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/takosumi" {
			t.Errorf("unexpected discovery path %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, discoveryBody(true))
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	disco, err := c.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if !disco.SupportsResourceShapes() {
		t.Fatalf("expected SupportsResourceShapes true")
	}
	if !disco.HasFeature("oidc") {
		t.Fatalf("expected oidc feature present")
	}
	if disco.Endpoints.Capabilities == "" {
		t.Fatalf("expected capabilities endpoint parsed")
	}
	if len(disco.APIVersions) != 1 || disco.APIVersions[0] != APIVersion {
		t.Fatalf("unexpected api_versions: %#v", disco.APIVersions)
	}
	// Discovery is cached on the client.
	if !c.Discovery.SupportsResourceShapes() {
		t.Fatalf("expected cached Discovery")
	}
}

func TestDiscover_ResourceShapesFalse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, discoveryBody(false))
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	disco, err := c.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if disco.SupportsResourceShapes() {
		t.Fatalf("expected SupportsResourceShapes false")
	}
}

func TestGetCapabilities(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/capabilities" {
			t.Errorf("unexpected capabilities path %q", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{
			"apiVersion":"takosumi.dev/v1alpha1",
				"resources":{"EdgeWorker":true,"ObjectBucket":true,"KVStore":true,"Queue":true,"SQLDatabase":true,"ContainerService":true,"VectorIndex":true,"DurableWorkflow":true,"StatefulActorNamespace":true,"Schedule":true},
			"adapters":{"opentofu":true}
		}`)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	caps, err := c.GetCapabilities(context.Background())
	if err != nil {
		t.Fatalf("GetCapabilities: %v", err)
	}
	if !caps.SupportsResource(KindEdgeWorker) {
		t.Fatalf("expected EdgeWorker capability: %#v", caps.Resources)
	}
	if !caps.SupportsResource(KindContainerService) {
		t.Fatalf("expected ContainerService capability: %#v", caps.Resources)
	}
	for _, kind := range []string{KindVectorIndex, KindDurableWorkflow, KindStatefulActorNamespace, KindSchedule} {
		if !caps.SupportsResource(kind) {
			t.Fatalf("expected %s capability: %#v", kind, caps.Resources)
		}
	}
	if !c.Capabilities.SupportsResource(KindEdgeWorker) {
		t.Fatalf("expected capabilities cached on client")
	}
}

func TestPutResource_RoundTrip(t *testing.T) {
	var gotBody applyResourceBody
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer secret-token" {
			t.Errorf("unexpected Authorization header %q", auth)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("unexpected Content-Type %q", ct)
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/resources/preview":
			var previewBody Resource
			if err := json.NewDecoder(r.Body).Decode(&previewBody); err != nil {
				t.Errorf("decode preview request: %v", err)
			}
			_ = json.NewEncoder(w).Encode(PreviewResourceResult{
				Resource:              previewBody,
				PlanDigest:            "sha256:plan",
				SpecDigest:            "sha256:spec",
				ResolutionFingerprint: "sha256:resolution",
				Quote: &DeploymentQuote{
					QuoteID:      "quote_1",
					QuoteDigest:  "sha256:quote",
					RatingStatus: "rated",
					Currency:     "USD",
					ExpiresAt:    "2026-07-14T01:00:00Z",
				},
			})
			return
		case r.Method == http.MethodPut && r.URL.Path == "/v1/resources/EdgeWorker/api":
			if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
				t.Errorf("decode apply request: %v", err)
			}
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}

		resp := Resource{
			APIVersion: APIVersion,
			Kind:       KindEdgeWorker,
			Metadata:   Metadata{Name: "api", Space: "prod"},
			Spec:       gotBody.Resource.Spec,
			Status: &Status{
				Phase:              "Ready",
				ObservedGeneration: 3,
				Resolution: Resolution{
					SelectedImplementation: "cloudflare_workers",
					Target:                 "cloudflare-main",
					Locked:                 true,
					Portability:            "mostly_portable",
				},
				Outputs: map[string]any{"worker_name": "api", "bytes": float64(12)},
				Conditions: []Condition{
					{Type: "Ready", Status: "True"},
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-token", srv.Client())
	body := &Resource{
		APIVersion: APIVersion,
		Kind:       KindEdgeWorker,
		Metadata:   Metadata{Name: "api", Space: "prod", ManagedBy: ManagedByOpenTofu},
		Spec: map[string]any{
			"name":   "api",
			"source": map[string]any{"artifactPath": "/work/dist/worker.js"},
		},
	}
	out, err := c.PutResource(context.Background(), KindEdgeWorker, "api", body)
	if err != nil {
		t.Fatalf("PutResource: %v", err)
	}

	// Request body was serialized correctly.
	if gotBody.Metadata.ManagedBy != ManagedByOpenTofu {
		t.Errorf("expected managedBy=opentofu, got %q", gotBody.Metadata.ManagedBy)
	}
	if gotBody.Spec["name"] != "api" {
		t.Errorf("expected spec.name=api, got %v", gotBody.Spec["name"])
	}
	if gotBody.Review.PlanDigest != "sha256:plan" || gotBody.Review.QuoteID != "quote_1" || gotBody.Review.QuoteDigest != "sha256:quote" {
		t.Errorf("unexpected deployment review %#v", gotBody.Review)
	}

	// Response mapped correctly.
	if out.Status == nil {
		t.Fatalf("expected status in response")
	}
	if out.Status.Resolution.SelectedImplementation != "cloudflare_workers" {
		t.Errorf("unexpected selectedImplementation %q", out.Status.Resolution.SelectedImplementation)
	}
	if !out.Status.Resolution.Locked {
		t.Errorf("expected locked true")
	}
	if out.Status.Outputs["worker_name"] != "api" {
		t.Errorf("unexpected outputs %#v", out.Status.Outputs)
	}
	if out.Status.Outputs["bytes"] != float64(12) {
		t.Errorf("expected numeric output preserved, got %#v", out.Status.Outputs["bytes"])
	}
}

func TestGetResource_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("space"); got != "prod" {
			t.Errorf("expected space query prod, got %q", got)
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"no such resource","requestId":"req-1"}}`)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	_, err := c.GetResource(context.Background(), KindEdgeWorker, "missing", "prod")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestObserveResource(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/v1/resources/ObjectBucket/assets/observe" {
			t.Errorf("unexpected observe path %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("space"); got != "prod" {
			t.Errorf("expected space query prod, got %q", got)
		}
		_ = json.NewEncoder(w).Encode(Resource{
			APIVersion: APIVersion,
			Kind:       KindObjectBucket,
			Status: &Status{Conditions: []Condition{{
				Type: "Drifted", Status: "false", Reason: "BackendInSync",
			}}},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	out, err := c.ObserveResource(context.Background(), KindObjectBucket, "assets", "prod")
	if err != nil {
		t.Fatalf("ObserveResource: %v", err)
	}
	if out.Status == nil || len(out.Status.Conditions) != 1 || out.Status.Conditions[0].Type != "Drifted" {
		t.Fatalf("unexpected observed Resource %#v", out)
	}
}

func TestRefreshResource(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/v1/resources/ObjectBucket/assets/refresh" {
			t.Errorf("unexpected refresh path %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("space"); got != "prod" {
			t.Errorf("expected space query prod, got %q", got)
		}
		_ = json.NewEncoder(w).Encode(Resource{
			APIVersion: APIVersion,
			Kind:       KindObjectBucket,
			Status: &Status{Outputs: map[string]any{
				"bucket_name": "assets-refreshed",
			}},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	out, err := c.RefreshResource(context.Background(), KindObjectBucket, "assets", "prod")
	if err != nil {
		t.Fatalf("RefreshResource: %v", err)
	}
	if out.Status == nil || out.Status.Outputs["bucket_name"] != "assets-refreshed" {
		t.Fatalf("unexpected refreshed Resource %#v", out)
	}
}

func TestImportResource(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/v1/resources/ObjectBucket/assets/import" {
			t.Errorf("unexpected import path %q", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode import body: %v", err)
		}
		if body["nativeId"] != "bucket-native-123" {
			t.Errorf("unexpected nativeId %#v", body["nativeId"])
		}
		metadata, _ := body["metadata"].(map[string]any)
		if metadata["space"] != "prod" {
			t.Errorf("unexpected metadata %#v", metadata)
		}
		_ = json.NewEncoder(w).Encode(Resource{
			APIVersion: APIVersion,
			Kind:       KindObjectBucket,
			Status: &Status{Outputs: map[string]any{
				"bucket_name": "assets",
			}},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	out, err := c.ImportResource(
		context.Background(),
		KindObjectBucket,
		"assets",
		"bucket-native-123",
		&Resource{
			APIVersion: APIVersion,
			Kind:       KindObjectBucket,
			Metadata:   Metadata{Name: "assets", Space: "prod"},
			Spec:       map[string]any{"name": "assets"},
		},
	)
	if err != nil {
		t.Fatalf("ImportResource: %v", err)
	}
	if out.Status == nil || out.Status.Outputs["bucket_name"] != "assets" {
		t.Fatalf("unexpected imported Resource %#v", out)
	}
}

func TestErrorEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		// Nested error envelope: the "error" field is an object.
		_, _ = io.WriteString(w, `{"error":{"code":"invalid_spec","message":"interfaces must not be empty","requestId":"req-42","details":{"field":"interfaces"}}}`)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	_, err := c.PutResource(context.Background(), KindEdgeWorker, "api", &Resource{})
	if err == nil {
		t.Fatalf("expected error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if apiErr.StatusCode != http.StatusBadRequest {
		t.Errorf("unexpected status %d", apiErr.StatusCode)
	}
	if apiErr.Code != "invalid_spec" {
		t.Errorf("unexpected code %q", apiErr.Code)
	}
	if apiErr.Message != "interfaces must not be empty" {
		t.Errorf("unexpected message %q", apiErr.Message)
	}
	if apiErr.RequestID != "req-42" {
		t.Errorf("unexpected requestId %q", apiErr.RequestID)
	}
	if string(apiErr.Details) != `{"field":"interfaces"}` {
		t.Errorf("unexpected details %q", string(apiErr.Details))
	}
	if msg := apiErr.Error(); msg == "" {
		t.Errorf("expected non-empty error string")
	}
}

func TestDeleteResource(t *testing.T) {
	t.Run("no content", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodDelete {
				t.Errorf("expected DELETE, got %s", r.Method)
			}
			if got := r.URL.Query().Get("space"); got != "prod" {
				t.Errorf("expected space query prod, got %q", got)
			}
			if got := r.URL.Query().Get("managedBy"); got != ManagedByOpenTofu {
				t.Errorf("expected managedBy query %q, got %q", ManagedByOpenTofu, got)
			}
			w.WriteHeader(http.StatusNoContent)
		}))
		defer srv.Close()

		c := New(srv.URL, "", srv.Client())
		if err := c.DeleteResource(context.Background(), KindEdgeWorker, "api", "prod"); err != nil {
			t.Fatalf("DeleteResource: %v", err)
		}
	})

	t.Run("already gone is success", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		defer srv.Close()

		c := New(srv.URL, "", srv.Client())
		if err := c.DeleteResource(context.Background(), KindEdgeWorker, "api", "prod"); err != nil {
			t.Fatalf("expected nil error on 404 delete, got %v", err)
		}
	})
}

func TestTargetPoolCRUD(t *testing.T) {
	var gotBody struct {
		Space string         `json:"space"`
		Spec  TargetPoolSpec `json:"spec"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/target-pools/default" {
			t.Errorf("unexpected target pool path %q", r.URL.Path)
		}
		switch r.Method {
		case http.MethodPut:
			if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
				t.Errorf("decode request: %v", err)
			}
			if gotBody.Space != "prod" {
				t.Errorf("expected prod space, got %q", gotBody.Space)
			}
			resp := TargetPoolRecord{
				ID:      "tkrn:prod:TargetPool:default",
				SpaceID: "prod",
				Name:    "default",
				Spec:    gotBody.Spec,
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
		case http.MethodGet:
			if got := r.URL.Query().Get("space"); got != "prod" {
				t.Errorf("expected space query prod, got %q", got)
			}
			resp := TargetPoolRecord{
				ID:      "tkrn:prod:TargetPool:default",
				SpaceID: "prod",
				Name:    "default",
				Spec: TargetPoolSpec{Targets: []TargetPoolEntry{{
					Name:     "containers-main",
					Type:     "kubernetes",
					Priority: 90,
				}}},
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
		case http.MethodDelete:
			if got := r.URL.Query().Get("space"); got != "prod" {
				t.Errorf("expected space query prod, got %q", got)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected method %s", r.Method)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := New(srv.URL, "tok", srv.Client())
	spec := TargetPoolSpec{Targets: []TargetPoolEntry{{
		Name:     "containers-main",
		Type:     "kubernetes",
		Ref:      "cluster-prod",
		Priority: 90,
		Implementations: []TargetImplementationDescriptor{{
			Shape:              KindContainerService,
			Implementation:     "custom_container_runtime",
			NativeResourceType: "custom.container_service",
			ProviderSource:     "example/runtime",
			ModuleTemplate:     "example-container-service",
			ProviderConfig: map[string]any{
				"endpoint": "https://runtime.example.test",
			},
			ModuleInputMappings: map[string]any{
				"name": map[string]any{"source": "spec", "path": "/name"},
			},
			ModuleOutputs: []TargetModuleOutput{{Name: "url", Type: "url"}},
			Interfaces: map[string]string{
				"oci_container": "native",
				"public_http":   "shim",
			},
		}},
	}}}
	put, err := c.PutTargetPool(context.Background(), "default", "prod", spec)
	if err != nil {
		t.Fatalf("PutTargetPool: %v", err)
	}
	if put.ID != "tkrn:prod:TargetPool:default" {
		t.Fatalf("unexpected put response %#v", put)
	}
	if gotBody.Spec.Targets[0].Implementations[0].Implementation != "custom_container_runtime" {
		t.Fatalf("custom container implementation did not pass through: %#v", gotBody.Spec)
	}
	gotImplementation := gotBody.Spec.Targets[0].Implementations[0]
	if gotImplementation.ProviderSource != "example/runtime" || gotImplementation.ModuleTemplate != "example-container-service" {
		t.Fatalf("explicit provider/module descriptor did not pass through: %#v", gotImplementation)
	}
	if gotImplementation.ModuleInputMappings["name"] == nil || len(gotImplementation.ModuleOutputs) != 1 {
		t.Fatalf("module mappings/outputs did not pass through: %#v", gotImplementation)
	}

	got, err := c.GetTargetPool(context.Background(), "default", "prod")
	if err != nil {
		t.Fatalf("GetTargetPool: %v", err)
	}
	if got.Spec.Targets[0].Type != "kubernetes" {
		t.Fatalf("unexpected target pool response %#v", got)
	}

	if err := c.DeleteTargetPool(context.Background(), "default", "prod"); err != nil {
		t.Fatalf("DeleteTargetPool: %v", err)
	}
}

func TestGetTargetPool_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"missing"}}`)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	_, err := c.GetTargetPool(context.Background(), "missing", "prod")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestPreviewResource(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/v1/resources/preview" {
			t.Errorf("unexpected preview path %q", r.URL.Path)
		}
		resp := PreviewResourceResult{
			Resource: Resource{
				APIVersion: APIVersion,
				Kind:       KindContainerService,
				Status: &Status{
					Conditions: []Condition{{Type: "Blocked", Status: "True", Message: "policy denies gcp"}},
				},
			},
			SelectedImplementation: "kubernetes_deployment",
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	out, err := c.PreviewResource(context.Background(), &Resource{Kind: KindContainerService})
	if err != nil {
		t.Fatalf("PreviewResource: %v", err)
	}
	if out.Resource.Status == nil || len(out.Resource.Status.Conditions) != 1 {
		t.Fatalf("unexpected preview status %#v", out.Resource.Status)
	}
	if out.Resource.Status.Conditions[0].Type != "Blocked" {
		t.Errorf("unexpected condition %#v", out.Resource.Status.Conditions[0])
	}
	if out.SelectedImplementation != "kubernetes_deployment" {
		t.Errorf("unexpected selected implementation %q", out.SelectedImplementation)
	}
}

func TestNewTrimsTrailingSlash(t *testing.T) {
	c := New("https://takosumi.example.com/", "", nil)
	if c.Endpoint() != "https://takosumi.example.com" {
		t.Fatalf("expected trailing slash trimmed, got %q", c.Endpoint())
	}
}
