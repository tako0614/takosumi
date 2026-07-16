package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

func interfaceDataSourceReadRequest(t *testing.T, d *interfaceDataSource, config interfaceDataSourceModel) (datasource.ReadRequest, *datasource.ReadResponse) {
	t.Helper()
	ctx := context.Background()
	var schemaResp datasource.SchemaResponse
	d.Schema(ctx, datasource.SchemaRequest{}, &schemaResp)
	if schemaResp.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics: %v", schemaResp.Diagnostics)
	}
	// tfsdk.Config has no Set helper; borrow tfsdk.State to build the raw value.
	helper := tfsdk.State{Schema: schemaResp.Schema}
	if diags := helper.Set(ctx, config); diags.HasError() {
		t.Fatalf("config diagnostics: %v", diags)
	}
	req := datasource.ReadRequest{Config: tfsdk.Config{Schema: schemaResp.Schema, Raw: helper.Raw}}
	resp := &datasource.ReadResponse{State: tfsdk.State{Schema: schemaResp.Schema}}
	return req, resp
}

func emptyInterfaceDataSourceModel() interfaceDataSourceModel {
	return interfaceDataSourceModel{
		ID:               types.StringNull(),
		Name:             types.StringNull(),
		OwnerID:          types.StringNull(),
		Type:             types.StringNull(),
		Version:          types.StringNull(),
		DocumentJSON:     types.StringNull(),
		ResolvedInputs:   types.MapNull(types.StringType),
		Phase:            types.StringNull(),
		ResolvedRevision: types.Int64Null(),
	}
}

func testInterfaceDataRecord(id, name, ownerID string) map[string]any {
	return map[string]any{
		"apiVersion": client.APIVersion,
		"kind":       client.KindInterface,
		"metadata": map[string]any{
			"id":          id,
			"workspaceId": "ws_1",
			"name":        name,
			"ownerRef":    map[string]any{"kind": "Capsule", "id": ownerID},
			"generation":  2,
		},
		"spec": map[string]any{
			"type":     "mcp.server",
			"version":  "2025-11-25",
			"document": map[string]any{"transport": "streamable-http"},
			"access":   map[string]any{"visibility": "workspace"},
		},
		"status": map[string]any{
			"phase":              "Resolved",
			"observedGeneration": 2,
			"resolvedRevision":   5,
			"resolvedInputs": map[string]any{
				"endpoint": "https://mcp.example.com",
				"meta":     map[string]any{"weight": 1},
			},
		},
	}
}

func TestInterfaceDataSourceLookupByID(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/interfaces/if_1" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-2-5"`)
		_ = json.NewEncoder(w).Encode(testInterfaceDataRecord("if_1", "primary-mcp", "cap_1"))
	}))
	defer srv.Close()

	d := &interfaceDataSource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	config := emptyInterfaceDataSourceModel()
	config.ID = types.StringValue("if_1")
	req, resp := interfaceDataSourceReadRequest(t, d, config)
	d.Read(ctx, req, resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("read diagnostics: %v", resp.Diagnostics)
	}
	var got interfaceDataSourceModel
	if diags := resp.State.Get(ctx, &got); diags.HasError() {
		t.Fatalf("state diagnostics: %v", diags)
	}
	if got.Name.ValueString() != "primary-mcp" || got.OwnerID.ValueString() != "cap_1" {
		t.Fatalf("unexpected identity %#v", got)
	}
	if got.Type.ValueString() != "mcp.server" || got.Version.ValueString() != "2025-11-25" {
		t.Fatalf("unexpected spec %#v", got)
	}
	if got.DocumentJSON.ValueString() != `{"transport":"streamable-http"}` {
		t.Fatalf("unexpected document %q", got.DocumentJSON.ValueString())
	}
	if got.Phase.ValueString() != "Resolved" || got.ResolvedRevision.ValueInt64() != 5 {
		t.Fatalf("unexpected status %#v", got)
	}
	resolved := map[string]string{}
	if diags := got.ResolvedInputs.ElementsAs(ctx, &resolved, false); diags.HasError() {
		t.Fatalf("resolved inputs diagnostics: %v", diags)
	}
	if resolved["endpoint"] != "https://mcp.example.com" {
		t.Fatalf("unexpected resolved endpoint %q", resolved["endpoint"])
	}
	// Non-string resolved values are JSON-encoded.
	if resolved["meta"] != `{"weight":1}` {
		t.Fatalf("unexpected resolved meta %q", resolved["meta"])
	}
}

func TestInterfaceDataSourceLookupByName(t *testing.T) {
	setAmbientRunIdentity(t, "ws_1", "cap_1")
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/interfaces" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		query := r.URL.Query()
		if query.Get("workspaceId") != "ws_1" {
			t.Errorf("expected ambient workspaceId query, got %q", query.Get("workspaceId"))
		}
		if query.Get("ownerId") != "cap_owner" {
			t.Errorf("expected ownerId query, got %q", query.Get("ownerId"))
		}
		if query.Has("name") {
			t.Errorf("GET /v1/interfaces has no name filter; it must not be sent")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"interfaces": []any{
				testInterfaceDataRecord("if_1", "other-mcp", "cap_owner"),
				testInterfaceDataRecord("if_2", "primary-mcp", "cap_owner"),
			},
		})
	}))
	defer srv.Close()

	d := &interfaceDataSource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	config := emptyInterfaceDataSourceModel()
	config.Name = types.StringValue("primary-mcp")
	config.OwnerID = types.StringValue("cap_owner")
	req, resp := interfaceDataSourceReadRequest(t, d, config)
	d.Read(ctx, req, resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("read diagnostics: %v", resp.Diagnostics)
	}
	var got interfaceDataSourceModel
	if diags := resp.State.Get(ctx, &got); diags.HasError() {
		t.Fatalf("state diagnostics: %v", diags)
	}
	if got.ID.ValueString() != "if_2" {
		t.Fatalf("expected the name-matched Interface, got %#v", got)
	}
}

// F2: the transport carries any JSON document; an id lookup of an Interface
// whose document is a non-object (here an array) must decode, not error.
func TestInterfaceDataSourceLookupByIDNonObjectDocument(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/interfaces/if_1" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		record := testInterfaceDataRecord("if_1", "primary-mcp", "cap_1")
		spec, _ := record["spec"].(map[string]any)
		spec["document"] = []any{"a", float64(1), true}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(record)
	}))
	defer srv.Close()

	d := &interfaceDataSource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	config := emptyInterfaceDataSourceModel()
	config.ID = types.StringValue("if_1")
	req, resp := interfaceDataSourceReadRequest(t, d, config)
	d.Read(ctx, req, resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("a non-object document must not break the id lookup: %v", resp.Diagnostics)
	}
	var got interfaceDataSourceModel
	if diags := resp.State.Get(ctx, &got); diags.HasError() {
		t.Fatalf("state diagnostics: %v", diags)
	}
	if got.DocumentJSON.ValueString() != `["a",1,true]` {
		t.Fatalf("expected canonical array document, got %q", got.DocumentJSON.ValueString())
	}
}

// F2: a name lookup lists every Workspace record and decodes them all. A single
// peer with a non-object document must not poison the whole lookup.
func TestInterfaceDataSourceLookupByNameToleratesNonObjectPeer(t *testing.T) {
	setAmbientRunIdentity(t, "ws_1", "cap_1")
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/interfaces" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		peer := testInterfaceDataRecord("if_1", "other-mcp", "cap_owner")
		peerSpec, _ := peer["spec"].(map[string]any)
		peerSpec["document"] = "just-a-string"
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"interfaces": []any{
				peer,
				testInterfaceDataRecord("if_2", "primary-mcp", "cap_owner"),
			},
		})
	}))
	defer srv.Close()

	d := &interfaceDataSource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	config := emptyInterfaceDataSourceModel()
	config.Name = types.StringValue("primary-mcp")
	config.OwnerID = types.StringValue("cap_owner")
	req, resp := interfaceDataSourceReadRequest(t, d, config)
	d.Read(ctx, req, resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("a single non-object document among peers must not break the name lookup: %v", resp.Diagnostics)
	}
	var got interfaceDataSourceModel
	if diags := resp.State.Get(ctx, &got); diags.HasError() {
		t.Fatalf("state diagnostics: %v", diags)
	}
	if got.ID.ValueString() != "if_2" {
		t.Fatalf("expected the matched object-document Interface, got %#v", got)
	}
}

func TestInterfaceDataSourceLookupByNameRequiresAmbientWorkspace(t *testing.T) {
	setAmbientRunIdentity(t, "", "")
	ctx := context.Background()
	d := &interfaceDataSource{data: &providerData{client: client.New("https://takosumi.example.com", "", nil)}}
	config := emptyInterfaceDataSourceModel()
	config.Name = types.StringValue("primary-mcp")
	req, resp := interfaceDataSourceReadRequest(t, d, config)
	d.Read(ctx, req, resp)
	if !resp.Diagnostics.HasError() {
		t.Fatal("expected name lookup to fail without ambient workspace")
	}
	found := false
	for _, diag := range resp.Diagnostics.Errors() {
		if strings.Contains(diag.Detail(), envWorkspaceID) {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected ambient workspace message, got %v", resp.Diagnostics)
	}
}

func TestInterfaceDataSourceRequiresIDOrName(t *testing.T) {
	ctx := context.Background()
	d := &interfaceDataSource{data: &providerData{client: client.New("https://takosumi.example.com", "", nil)}}
	req, resp := interfaceDataSourceReadRequest(t, d, emptyInterfaceDataSourceModel())
	d.Read(ctx, req, resp)
	if !resp.Diagnostics.HasError() {
		t.Fatal("expected an error when neither id nor name is set")
	}
}

func TestInterfaceDataSourceRejectsBothIDAndName(t *testing.T) {
	ctx := context.Background()
	d := &interfaceDataSource{data: &providerData{client: client.New("https://takosumi.example.com", "", nil)}}
	config := emptyInterfaceDataSourceModel()
	config.ID = types.StringValue("if_1")
	config.Name = types.StringValue("primary-mcp")
	req, resp := interfaceDataSourceReadRequest(t, d, config)
	d.Read(ctx, req, resp)
	if !resp.Diagnostics.HasError() {
		t.Fatal("expected an error when both id and name are set")
	}
}

func TestInterfaceDataSourceSchemaIsValid(t *testing.T) {
	ctx := context.Background()
	var schemaResp datasource.SchemaResponse
	(&interfaceDataSource{}).Schema(ctx, datasource.SchemaRequest{}, &schemaResp)
	if schemaResp.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics: %v", schemaResp.Diagnostics)
	}
	if diags := schemaResp.Schema.ValidateImplementation(ctx); diags.HasError() {
		t.Fatalf("schema implementation diagnostics: %v", diags)
	}
}

func TestProviderRegistersInterfaceDataSource(t *testing.T) {
	ctx := context.Background()
	p := &takosumiProvider{}
	factories := p.DataSources(ctx)
	if len(factories) != 1 {
		t.Fatalf("expected one data source, got %d", len(factories))
	}
	var resp datasource.MetadataResponse
	factories[0]().Metadata(ctx, datasource.MetadataRequest{ProviderTypeName: "takosumi"}, &resp)
	if resp.TypeName != "takosumi_interface" {
		t.Fatalf("unexpected data source type name %q", resp.TypeName)
	}
}
