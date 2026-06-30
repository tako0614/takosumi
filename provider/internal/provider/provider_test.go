package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
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
					"EdgeWorker":       resourceShapes,
					"ObjectBucket":     resourceShapes,
					"KVStore":          resourceShapes,
					"Queue":            resourceShapes,
					"SQLDatabase":      resourceShapes,
					"ContainerService": resourceShapes,
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
					"EdgeWorker":       false,
					"ContainerService": false,
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

func TestProviderResourcesIncludeCurrentShapeResources(t *testing.T) {
	got := providerResourceTypeNames(t)
	want := currentProviderResourceTypeNames()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("unexpected provider resource set:\ngot  %v\nwant %v", got, want)
	}
}

func TestProviderExampleResourcesMatchCurrentResources(t *testing.T) {
	entries, err := os.ReadDir(filepath.Clean("../../examples/resources"))
	if err != nil {
		t.Fatalf("read examples/resources: %v", err)
	}
	got := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			got = append(got, entry.Name())
		}
	}
	sort.Strings(got)
	want := currentProviderResourceTypeNames()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("example resource directories must match provider resources:\ngot  %v\nwant %v", got, want)
	}
}

func currentProviderResourceTypeNames() []string {
	names := []string{
		"takosumi_edge_worker",
		"takosumi_object_bucket",
		"takosumi_kv_store",
		"takosumi_queue",
		"takosumi_sql_database",
		"takosumi_container_service",
		"takosumi_target_pool",
	}
	sort.Strings(names)
	return names
}

func providerResourceTypeNames(t *testing.T) []string {
	t.Helper()
	p := &takosumiProvider{}
	got := make([]string, 0, len(p.Resources(context.Background())))
	for _, factory := range p.Resources(context.Background()) {
		res := factory()
		var resp frameworkresource.MetadataResponse
		res.Metadata(context.Background(), frameworkresource.MetadataRequest{
			ProviderTypeName: "takosumi",
		}, &resp)
		got = append(got, resp.TypeName)
	}
	sort.Strings(got)
	return got
}

func TestConfigureClient_AcceptsContainerServiceOnlyCapabilities(t *testing.T) {
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
					"EdgeWorker":       false,
					"ContainerService": true,
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
	if !c.Capabilities.SupportsResource("ContainerService") {
		t.Fatalf("expected ContainerService capability cached")
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
