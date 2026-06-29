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
			"resources":{"ObjectBucket":true,"EdgeWorker":true,"AIEndpoint":true},
			"adapters":{"opentofu":true}
		}`)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	caps, err := c.GetCapabilities(context.Background())
	if err != nil {
		t.Fatalf("GetCapabilities: %v", err)
	}
	if !caps.SupportsResource(KindObjectBucket) || !caps.SupportsResource(KindEdgeWorker) {
		t.Fatalf("expected ObjectBucket and EdgeWorker capabilities: %#v", caps.Resources)
	}
	if !caps.SupportsResource(KindAIEndpoint) {
		t.Fatalf("expected AIEndpoint capability: %#v", caps.Resources)
	}
	if !c.Capabilities.SupportsResource(KindEdgeWorker) {
		t.Fatalf("expected capabilities cached on client")
	}
}

func TestPutResource_RoundTrip(t *testing.T) {
	var gotBody Resource
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("expected PUT, got %s", r.Method)
		}
		if r.URL.Path != "/v1/resources/ObjectBucket/assets" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer secret-token" {
			t.Errorf("unexpected Authorization header %q", auth)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("unexpected Content-Type %q", ct)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode request: %v", err)
		}

		resp := Resource{
			APIVersion: APIVersion,
			Kind:       KindObjectBucket,
			Metadata:   Metadata{Name: "assets", Space: "prod"},
			Spec:       gotBody.Spec,
			Status: &Status{
				Phase:              "Ready",
				ObservedGeneration: 3,
				Resolution: Resolution{
					SelectedImplementation: "cloudflare_r2",
					Target:                 "cloudflare-main",
					Locked:                 true,
					Portability:            "mostly_portable",
				},
				Outputs: map[string]any{"bucket": "assets-prod", "bytes": float64(12)},
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
		Kind:       KindObjectBucket,
		Metadata:   Metadata{Name: "assets", Space: "prod", ManagedBy: ManagedByOpenTofu},
		Spec: map[string]any{
			"name":            "assets",
			"interfaces":      []string{"s3_api", "signed_url"},
			"lifecyclePolicy": map[string]any{"delete": "retain"},
		},
	}
	out, err := c.PutResource(context.Background(), KindObjectBucket, "assets", body)
	if err != nil {
		t.Fatalf("PutResource: %v", err)
	}

	// Request body was serialized correctly.
	if gotBody.Metadata.ManagedBy != ManagedByOpenTofu {
		t.Errorf("expected managedBy=opentofu, got %q", gotBody.Metadata.ManagedBy)
	}
	if gotBody.Spec["name"] != "assets" {
		t.Errorf("expected spec.name=assets, got %v", gotBody.Spec["name"])
	}

	// Response mapped correctly.
	if out.Status == nil {
		t.Fatalf("expected status in response")
	}
	if out.Status.Resolution.SelectedImplementation != "cloudflare_r2" {
		t.Errorf("unexpected selectedImplementation %q", out.Status.Resolution.SelectedImplementation)
	}
	if !out.Status.Resolution.Locked {
		t.Errorf("expected locked true")
	}
	if out.Status.Outputs["bucket"] != "assets-prod" {
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
	_, err := c.GetResource(context.Background(), KindObjectBucket, "missing", "prod")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
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
	_, err := c.PutResource(context.Background(), KindObjectBucket, "assets", &Resource{})
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
			w.WriteHeader(http.StatusNoContent)
		}))
		defer srv.Close()

		c := New(srv.URL, "", srv.Client())
		if err := c.DeleteResource(context.Background(), KindObjectBucket, "assets", "prod"); err != nil {
			t.Fatalf("DeleteResource: %v", err)
		}
	})

	t.Run("already gone is success", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		defer srv.Close()

		c := New(srv.URL, "", srv.Client())
		if err := c.DeleteResource(context.Background(), KindObjectBucket, "assets", "prod"); err != nil {
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
					Name:     "deepseek-main",
					Type:     "ai_provider",
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
		Name:     "deepseek-main",
		Type:     "ai_provider",
		Ref:      "https://api.deepseek.example/v1",
		Priority: 90,
		Implementations: []TargetPoolImplementation{{
			Shape:              KindAIEndpoint,
			Implementation:     "deepseek_openai_gateway",
			NativeResourceType: "ai.deepseek_endpoint",
			Interfaces: map[string]string{
				"openai_chat_completions":      "native",
				"vendor.deepseek.responses.v1": "native",
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
	if gotBody.Spec.Targets[0].Implementations[0].Implementation != "deepseek_openai_gateway" {
		t.Fatalf("custom AI implementation did not pass through: %#v", gotBody.Spec)
	}

	got, err := c.GetTargetPool(context.Background(), "default", "prod")
	if err != nil {
		t.Fatalf("GetTargetPool: %v", err)
	}
	if got.Spec.Targets[0].Type != "ai_provider" {
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
				Kind:       KindObjectBucket,
				Status: &Status{
					Conditions: []Condition{{Type: "Blocked", Status: "True", Message: "policy denies gcp"}},
				},
			},
			SelectedImplementation: "cloudflare_r2",
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	out, err := c.PreviewResource(context.Background(), &Resource{Kind: KindObjectBucket})
	if err != nil {
		t.Fatalf("PreviewResource: %v", err)
	}
	if out.Resource.Status == nil || len(out.Resource.Status.Conditions) != 1 {
		t.Fatalf("unexpected preview status %#v", out.Resource.Status)
	}
	if out.Resource.Status.Conditions[0].Type != "Blocked" {
		t.Errorf("unexpected condition %#v", out.Resource.Status.Conditions[0])
	}
	if out.SelectedImplementation != "cloudflare_r2" {
		t.Errorf("unexpected selected implementation %q", out.SelectedImplementation)
	}
}

func TestNewTrimsTrailingSlash(t *testing.T) {
	c := New("https://takosumi.example.com/", "", nil)
	if c.Endpoint() != "https://takosumi.example.com" {
		t.Fatalf("expected trailing slash trimmed, got %q", c.Endpoint())
	}
}
