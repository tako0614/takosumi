package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func discoveryHandler(t *testing.T, resourceShapes bool) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		switch r.URL.Path {
		case "/.well-known/takosumi":
			body = map[string]any{
				"api_versions": []string{"takosumi.dev/v1alpha1"},
				"features": map[string]bool{
					"resource_shapes": resourceShapes,
				},
				"endpoints": map[string]string{},
			}
		case "/v1/capabilities":
			body = map[string]any{
				"apiVersion": "takosumi.dev/v1alpha1",
				"resources": map[string]bool{
					"ObjectBucket": resourceShapes,
					"EdgeWorker":   resourceShapes,
					"AIEndpoint":   resourceShapes,
				},
			}
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		raw, _ := json.Marshal(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}
}

func versionedDiscoveryHandler(t *testing.T, discoveryVersion string, capabilityVersion string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		switch r.URL.Path {
		case "/.well-known/takosumi":
			body = map[string]any{
				"api_versions": []string{discoveryVersion},
				"features": map[string]bool{
					"resource_shapes": true,
				},
				"endpoints": map[string]string{},
			}
		case "/v1/capabilities":
			body = map[string]any{
				"apiVersion": capabilityVersion,
				"resources": map[string]bool{
					"ObjectBucket": true,
					"AIEndpoint":   false,
				},
			}
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		raw, _ := json.Marshal(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}
}

func TestConfigureClient_AcceptsAIEndpointOnlyCapabilities(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		switch r.URL.Path {
		case "/.well-known/takosumi":
			body = map[string]any{
				"api_versions": []string{"takosumi.dev/v1alpha1"},
				"features": map[string]bool{
					"resource_shapes": true,
				},
				"endpoints": map[string]string{},
			}
		case "/v1/capabilities":
			body = map[string]any{
				"apiVersion": "takosumi.dev/v1alpha1",
				"resources": map[string]bool{
					"ObjectBucket": false,
					"EdgeWorker":   false,
					"AIEndpoint":   true,
				},
			}
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		raw, _ := json.Marshal(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	defer srv.Close()

	c, err := configureClient(context.Background(), srv.URL, "tok", srv.Client())
	if err != nil {
		t.Fatalf("configureClient: %v", err)
	}
	if !c.Capabilities.SupportsResource("AIEndpoint") {
		t.Fatalf("expected AIEndpoint capability cached")
	}
}

func TestConfigureClient_AcceptsResourceShapeAPIForAdminConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		switch r.URL.Path {
		case "/.well-known/takosumi":
			body = map[string]any{
				"api_versions": []string{"takosumi.dev/v1alpha1"},
				"features": map[string]bool{
					"resource_shapes": true,
				},
				"endpoints": map[string]string{},
			}
		case "/v1/capabilities":
			body = map[string]any{
				"apiVersion": "takosumi.dev/v1alpha1",
				"resources":  map[string]bool{},
			}
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		raw, _ := json.Marshal(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	defer srv.Close()

	c, err := configureClient(context.Background(), srv.URL, "tok", srv.Client())
	if err != nil {
		t.Fatalf("configureClient: %v", err)
	}
	if c == nil {
		t.Fatalf("expected a client")
	}
}

func TestConfigureClient_AcceptsResourceShapes(t *testing.T) {
	srv := httptest.NewServer(discoveryHandler(t, true))
	defer srv.Close()

	c, err := configureClient(context.Background(), srv.URL, "tok", srv.Client())
	if err != nil {
		t.Fatalf("configureClient: %v", err)
	}
	if c == nil {
		t.Fatalf("expected a client")
	}
}

func TestConfigureClient_RejectsWhenResourceShapesFalse(t *testing.T) {
	srv := httptest.NewServer(discoveryHandler(t, false))
	defer srv.Close()

	_, err := configureClient(context.Background(), srv.URL, "", srv.Client())
	if err == nil {
		t.Fatalf("expected configuration to fail when resource_shapes is false")
	}
	if !strings.Contains(err.Error(), "does not expose the Resource Shape API") {
		t.Fatalf("expected a clear Resource Shape API diagnostic, got: %v", err)
	}
}

func TestConfigureClient_RejectsUnsupportedDiscoveryVersion(t *testing.T) {
	srv := httptest.NewServer(versionedDiscoveryHandler(t, "takosumi.dev/v0", "takosumi.dev/v1alpha1"))
	defer srv.Close()

	_, err := configureClient(context.Background(), srv.URL, "", srv.Client())
	if err == nil {
		t.Fatalf("expected configuration to fail on unsupported discovery api version")
	}
	if !strings.Contains(err.Error(), "does not advertise API version") {
		t.Fatalf("expected api version diagnostic, got: %v", err)
	}
}

func TestConfigureClient_RejectsUnsupportedCapabilitiesVersion(t *testing.T) {
	srv := httptest.NewServer(versionedDiscoveryHandler(t, "takosumi.dev/v1alpha1", "takosumi.dev/v0"))
	defer srv.Close()

	_, err := configureClient(context.Background(), srv.URL, "", srv.Client())
	if err == nil {
		t.Fatalf("expected configuration to fail on unsupported capabilities api version")
	}
	if !strings.Contains(err.Error(), "unsupported capabilities apiVersion") {
		t.Fatalf("expected capabilities apiVersion diagnostic, got: %v", err)
	}
}

func TestConfigureClient_DiscoveryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":{"code":"boom","message":"down"}}`)
	}))
	defer srv.Close()

	_, err := configureClient(context.Background(), srv.URL, "", srv.Client())
	if err == nil {
		t.Fatalf("expected discovery error")
	}
	if !strings.Contains(err.Error(), "discovering Takosumi endpoint") {
		t.Fatalf("expected discovery-wrapped error, got: %v", err)
	}
}

func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("", "", "x"); got != "x" {
		t.Fatalf("expected x, got %q", got)
	}
	if got := firstNonEmpty("a", "b"); got != "a" {
		t.Fatalf("expected a, got %q", got)
	}
	if got := firstNonEmpty("", ""); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}
