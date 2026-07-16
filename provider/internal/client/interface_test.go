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

func testInterfaceRecordJSON(id, name string, generation, resolvedRevision int64, phase string) map[string]any {
	return map[string]any{
		"apiVersion": APIVersion,
		"kind":       KindInterface,
		"metadata": map[string]any{
			"id":          id,
			"workspaceId": "ws_1",
			"name":        name,
			"ownerRef":    map[string]any{"kind": "Capsule", "id": "cap_1"},
			"generation":  generation,
			"labels":      map[string]string{},
			"materializedFrom": map[string]any{
				"source": "capsule_resource",
			},
		},
		"spec": map[string]any{
			"type":     "mcp.server",
			"version":  "2025-11-25",
			"document": map[string]any{"transport": "streamable-http"},
			"inputs": map[string]any{
				"endpoint": map[string]any{
					"source":     "capsule_output",
					"capsuleId":  "cap_1",
					"outputName": "mcp_url",
				},
			},
			"access": map[string]any{"visibility": "workspace", "resourceUriInput": "endpoint"},
		},
		"status": map[string]any{
			"phase":              phase,
			"observedGeneration": generation,
			"resolvedRevision":   resolvedRevision,
			"resolvedInputs":     map[string]any{"endpoint": "https://mcp.example.com"},
			"conditions":         []any{},
		},
	}
}

func TestCreateInterface_RoundTrip(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/interfaces" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer run-token" {
			t.Errorf("unexpected Authorization header %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-1-0"`)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(testInterfaceRecordJSON("if_1", "primary-mcp", 1, 0, "Pending"))
	}))
	defer srv.Close()

	c := New(srv.URL, "run-token", srv.Client())
	record, etag, err := c.CreateInterface(context.Background(), &CreateInterfaceRequest{
		WorkspaceID: "ws_1",
		Name:        "primary-mcp",
		OwnerRef:    InterfaceOwnerRef{Kind: "Capsule", ID: "cap_1"},
		Spec: InterfaceSpec{
			Type:     "mcp.server",
			Version:  "2025-11-25",
			Document: json.RawMessage(`{"transport":"streamable-http"}`),
			Inputs: map[string]InterfaceInput{
				"endpoint": {Source: "capsule_output", CapsuleID: "cap_1", OutputName: "mcp_url"},
				"note":     {Source: "literal", Value: json.RawMessage(`"public"`)},
			},
			Access: InterfaceAccess{Visibility: "workspace", ResourceURIInput: "endpoint"},
		},
	})
	if err != nil {
		t.Fatalf("CreateInterface: %v", err)
	}
	if etag != `"if-1-0"` {
		t.Fatalf("expected create ETag captured, got %q", etag)
	}
	if record.Metadata.ID != "if_1" || record.Metadata.OwnerRef.ID != "cap_1" {
		t.Fatalf("unexpected record %#v", record.Metadata)
	}
	if record.Status.Phase != "Pending" || record.Status.ResolvedRevision != 0 {
		t.Fatalf("unexpected status %#v", record.Status)
	}

	// Request body serialized the wire shape exactly.
	if gotBody["workspaceId"] != "ws_1" || gotBody["name"] != "primary-mcp" {
		t.Fatalf("unexpected body identity %#v", gotBody)
	}
	ownerRef, _ := gotBody["ownerRef"].(map[string]any)
	if ownerRef["kind"] != "Capsule" || ownerRef["id"] != "cap_1" {
		t.Fatalf("unexpected ownerRef %#v", ownerRef)
	}
	spec, _ := gotBody["spec"].(map[string]any)
	inputs, _ := spec["inputs"].(map[string]any)
	endpoint, _ := inputs["endpoint"].(map[string]any)
	if endpoint["source"] != "capsule_output" || endpoint["capsuleId"] != "cap_1" || endpoint["outputName"] != "mcp_url" {
		t.Fatalf("unexpected endpoint input %#v", endpoint)
	}
	if _, hasValue := endpoint["value"]; hasValue {
		t.Fatalf("capsule_output input must omit value, got %#v", endpoint)
	}
	note, _ := inputs["note"].(map[string]any)
	if note["source"] != "literal" || note["value"] != "public" {
		t.Fatalf("unexpected literal input %#v", note)
	}
	access, _ := spec["access"].(map[string]any)
	if access["visibility"] != "workspace" || access["resourceUriInput"] != "endpoint" {
		t.Fatalf("unexpected access %#v", access)
	}
}

func TestGetInterface_ReturnsETag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/interfaces/if_1" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-2-3"`)
		_ = json.NewEncoder(w).Encode(testInterfaceRecordJSON("if_1", "primary-mcp", 2, 3, "Resolved"))
	}))
	defer srv.Close()

	c := New(srv.URL, "run-token", srv.Client())
	record, etag, err := c.GetInterface(context.Background(), "if_1")
	if err != nil {
		t.Fatalf("GetInterface: %v", err)
	}
	if etag != `"if-2-3"` {
		t.Fatalf("expected ETag, got %q", etag)
	}
	if record.Spec.Inputs["endpoint"].OutputName != "mcp_url" {
		t.Fatalf("unexpected spec inputs %#v", record.Spec.Inputs)
	}
	if record.Status.ResolvedInputs["endpoint"] != "https://mcp.example.com" {
		t.Fatalf("unexpected resolved inputs %#v", record.Status.ResolvedInputs)
	}
}

func TestGetInterface_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"Interface not found"}}`)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	_, _, err := c.GetInterface(context.Background(), "missing")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestListInterfaces_QueryFilters(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/interfaces" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		query := r.URL.Query()
		if query.Get("workspaceId") != "ws_1" {
			t.Errorf("expected workspaceId query, got %q", query.Get("workspaceId"))
		}
		if query.Get("type") != "mcp.server" {
			t.Errorf("expected type query, got %q", query.Get("type"))
		}
		if query.Get("ownerKind") != "Capsule" {
			t.Errorf("expected ownerKind query, got %q", query.Get("ownerKind"))
		}
		if query.Get("ownerId") != "cap_1" {
			t.Errorf("expected ownerId query, got %q", query.Get("ownerId"))
		}
		if query.Has("name") {
			t.Errorf("GET /v1/interfaces has no name filter; it must not be sent")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"interfaces": []any{
				testInterfaceRecordJSON("if_1", "primary-mcp", 1, 1, "Resolved"),
				testInterfaceRecordJSON("if_2", "secondary-mcp", 1, 1, "Pending"),
			},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	records, err := c.ListInterfaces(context.Background(), InterfaceListFilter{
		WorkspaceID: "ws_1",
		Type:        "mcp.server",
		OwnerKind:   "Capsule",
		OwnerID:     "cap_1",
	})
	if err != nil {
		t.Fatalf("ListInterfaces: %v", err)
	}
	if len(records) != 2 || records[0].Metadata.ID != "if_1" || records[1].Metadata.Name != "secondary-mcp" {
		t.Fatalf("unexpected list %#v", records)
	}
}

func TestListInterfaces_RequiresWorkspace(t *testing.T) {
	c := New("https://takosumi.example.com", "", nil)
	if _, err := c.ListInterfaces(context.Background(), InterfaceListFilter{}); err == nil {
		t.Fatalf("expected error for missing workspaceId")
	}
}

func TestUpdateInterface_SendsIfMatch(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/v1/interfaces/if_1" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("If-Match"); got != `"if-2-3"` {
			t.Errorf("expected If-Match to equal the current ETag, got %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-3-3"`)
		_ = json.NewEncoder(w).Encode(testInterfaceRecordJSON("if_1", "renamed-mcp", 3, 3, "Resolved"))
	}))
	defer srv.Close()

	c := New(srv.URL, "run-token", srv.Client())
	labels := map[string]string{"tier": "gold"}
	record, etag, err := c.UpdateInterface(context.Background(), "if_1", `"if-2-3"`, &UpdateInterfaceRequest{
		Name:   "renamed-mcp",
		Labels: &labels,
		Spec: &InterfaceSpec{
			Type:     "mcp.server",
			Version:  "2025-11-25",
			Document: json.RawMessage(`{"transport":"streamable-http"}`),
			Access:   InterfaceAccess{Visibility: "workspace"},
		},
	})
	if err != nil {
		t.Fatalf("UpdateInterface: %v", err)
	}
	if etag != `"if-3-3"` {
		t.Fatalf("expected new ETag, got %q", etag)
	}
	if record.Metadata.Name != "renamed-mcp" {
		t.Fatalf("unexpected record %#v", record.Metadata)
	}
	if gotBody["name"] != "renamed-mcp" {
		t.Fatalf("unexpected body name %#v", gotBody["name"])
	}
	bodyLabels, _ := gotBody["labels"].(map[string]any)
	if bodyLabels["tier"] != "gold" {
		t.Fatalf("unexpected body labels %#v", gotBody["labels"])
	}
}

func TestUpdateInterface_PreconditionFailedEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusPreconditionFailed)
		_, _ = io.WriteString(w, `{"error":{"code":"failed_precondition","message":"If-Match must equal the current Interface ETag","requestId":"req-9"}}`)
	}))
	defer srv.Close()

	c := New(srv.URL, "", srv.Client())
	_, _, err := c.UpdateInterface(context.Background(), "if_1", `"if-1-0"`, &UpdateInterfaceRequest{Name: "x"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if apiErr.StatusCode != http.StatusPreconditionFailed || apiErr.Code != "failed_precondition" {
		t.Fatalf("unexpected api error %#v", apiErr)
	}
	if apiErr.RequestID != "req-9" {
		t.Fatalf("unexpected requestId %q", apiErr.RequestID)
	}
}

func TestDeleteInterface(t *testing.T) {
	t.Run("sends If-Match and accepts the retired record", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodDelete || r.URL.Path != "/v1/interfaces/if_1" {
				t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				http.NotFound(w, r)
				return
			}
			if got := r.Header.Get("If-Match"); got != `"if-3-3"` {
				t.Errorf("expected If-Match to equal the current ETag, got %q", got)
			}
			// DELETE /v1/interfaces/{id} retires and returns 200 + record.
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-4-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceRecordJSON("if_1", "primary-mcp", 4, 3, "Retired"))
		}))
		defer srv.Close()

		c := New(srv.URL, "run-token", srv.Client())
		if err := c.DeleteInterface(context.Background(), "if_1", `"if-3-3"`); err != nil {
			t.Fatalf("DeleteInterface: %v", err)
		}
	})

	t.Run("already gone is success", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"Interface not found"}}`)
		}))
		defer srv.Close()

		c := New(srv.URL, "", srv.Client())
		if err := c.DeleteInterface(context.Background(), "if_1", `"if-3-3"`); err != nil {
			t.Fatalf("expected nil error on 404 delete, got %v", err)
		}
	})
}
