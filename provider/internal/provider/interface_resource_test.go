package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	frameworkvalidator "github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

func setAmbientRunIdentity(t *testing.T, workspaceID, capsuleID string) {
	t.Helper()
	t.Setenv(envWorkspaceID, workspaceID)
	t.Setenv(envCapsuleID, capsuleID)
}

func testInterfaceInput(t *testing.T, values map[string]attr.Value) attr.Value {
	t.Helper()
	full := map[string]attr.Value{
		"source":      types.StringNull(),
		"output_name": types.StringNull(),
		"capsule_id":  types.StringNull(),
		"resource_id": types.StringNull(),
		"pointer":     types.StringNull(),
		"value_json":  types.StringNull(),
	}
	for key, value := range values {
		full[key] = value
	}
	object, diags := types.ObjectValue(interfaceInputAttrTypes, full)
	if diags.HasError() {
		t.Fatalf("input object diagnostics: %v", diags)
	}
	return object
}

func testInterfaceInputsMap(t *testing.T, entries map[string]attr.Value) types.Map {
	t.Helper()
	value, diags := types.MapValue(types.ObjectType{AttrTypes: interfaceInputAttrTypes}, entries)
	if diags.HasError() {
		t.Fatalf("inputs map diagnostics: %v", diags)
	}
	return value
}

func testInterfaceServerRecord(id, name string, generation, resolvedRevision int64, phase string, spec map[string]any) map[string]any {
	return map[string]any{
		"apiVersion": client.APIVersion,
		"kind":       client.KindInterface,
		"metadata": map[string]any{
			"id":               id,
			"workspaceId":      "ws_1",
			"name":             name,
			"ownerRef":         map[string]any{"kind": "Capsule", "id": "cap_1"},
			"generation":       generation,
			"labels":           map[string]string{},
			"materializedFrom": map[string]any{"source": "capsule_resource"},
		},
		"spec": spec,
		"status": map[string]any{
			"phase":              phase,
			"observedGeneration": generation,
			"resolvedRevision":   resolvedRevision,
		},
	}
}

func interfaceResourceSchemaResponse(t *testing.T, r *interfaceResource) frameworkresource.SchemaResponse {
	t.Helper()
	var resp frameworkresource.SchemaResponse
	r.Schema(context.Background(), frameworkresource.SchemaRequest{}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics: %v", resp.Diagnostics)
	}
	return resp
}

func TestInterfacePlanDoesNotStartRemotePreview(t *testing.T) {
	if _, ok := NewInterfaceResource().(frameworkresource.ResourceWithModifyPlan); ok {
		t.Fatal("takosumi_interface must not call the Takosumi API during OpenTofu planning")
	}
}

func TestInterfaceResourceSchemaIsValid(t *testing.T) {
	ctx := context.Background()
	schemaResp := interfaceResourceSchemaResponse(t, &interfaceResource{})
	if diags := schemaResp.Schema.ValidateImplementation(ctx); diags.HasError() {
		t.Fatalf("schema implementation diagnostics: %v", diags)
	}
	if !strings.Contains(schemaResp.Schema.MarkdownDescription, "InterfaceBinding") {
		t.Fatal("schema must state that InterfaceBindings stay user-side")
	}
}

func TestInterfaceDocumentJSONValidator(t *testing.T) {
	cases := map[string]bool{
		`{}`:                  true,
		`{"transport":"h"}`:   true,
		`[]`:                  false,
		`"string"`:            false,
		`null`:                false,
		`{"broken":`:          false,
		`{"nested":{"ok":1}}`: true,
	}
	for input, valid := range cases {
		resp := frameworkvalidator.StringResponse{}
		StringJSONObject().ValidateString(context.Background(), frameworkvalidator.StringRequest{
			ConfigValue: types.StringValue(input),
		}, &resp)
		if resp.Diagnostics.HasError() == valid {
			t.Fatalf("StringJSONObject(%q): expected valid=%v, diagnostics %v", input, valid, resp.Diagnostics)
		}
	}
}

func TestInterfaceToSpecFillsAmbientCapsuleID(t *testing.T) {
	model := interfaceResourceModel{
		Name:         types.StringValue("primary-mcp"),
		Type:         types.StringValue("mcp.server"),
		Version:      types.StringValue("2025-11-25"),
		DocumentJSON: types.StringValue(`{"transport":"streamable-http"}`),
		Inputs: testInterfaceInputsMap(t, map[string]attr.Value{
			"endpoint": testInterfaceInput(t, map[string]attr.Value{
				"source":      types.StringValue("capsule_output"),
				"output_name": types.StringValue("mcp_url"),
			}),
			"other": testInterfaceInput(t, map[string]attr.Value{
				"source":      types.StringValue("capsule_output"),
				"output_name": types.StringValue("other_url"),
				"capsule_id":  types.StringValue("cap_explicit"),
			}),
		}),
	}
	spec, diags := model.toSpec(context.Background(), "cap_ambient", "")
	if diags.HasError() {
		t.Fatalf("toSpec diagnostics: %v", diags)
	}
	if spec.Inputs["endpoint"].CapsuleID != "cap_ambient" {
		t.Fatalf("expected ambient capsule id fill, got %#v", spec.Inputs["endpoint"])
	}
	if spec.Inputs["other"].CapsuleID != "cap_explicit" {
		t.Fatalf("expected explicit capsule id kept, got %#v", spec.Inputs["other"])
	}
	if spec.Access.Visibility != "workspace" {
		t.Fatalf("expected default workspace visibility, got %q", spec.Access.Visibility)
	}
}

func TestInterfaceToSpecRejectsInvalidInputs(t *testing.T) {
	cases := []map[string]attr.Value{
		// literal without value_json
		{"source": types.StringValue("literal")},
		// literal with an output reference
		{
			"source":      types.StringValue("literal"),
			"value_json":  types.StringValue(`"x"`),
			"output_name": types.StringValue("mcp_url"),
		},
		// capsule_output without output_name
		{"source": types.StringValue("capsule_output")},
		// resource_output without resource_id
		{
			"source":      types.StringValue("resource_output"),
			"output_name": types.StringValue("url"),
		},
	}
	for index, input := range cases {
		model := interfaceResourceModel{
			Name:         types.StringValue("primary-mcp"),
			Type:         types.StringValue("mcp.server"),
			Version:      types.StringValue("2025-11-25"),
			DocumentJSON: types.StringValue(`{}`),
			Inputs: testInterfaceInputsMap(t, map[string]attr.Value{
				"bad": testInterfaceInput(t, input),
			}),
		}
		if _, diags := model.toSpec(context.Background(), "cap_1", ""); !diags.HasError() {
			t.Fatalf("case %d: expected diagnostics for %#v", index, input)
		}
	}
}

func TestInterfaceCreateMissingAmbientIdentity(t *testing.T) {
	setAmbientRunIdentity(t, "", "")
	ctx := context.Background()
	r := &interfaceResource{data: &providerData{client: client.New("https://takosumi.example.com", "", nil)}}
	schemaResp := interfaceResourceSchemaResponse(t, r)
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	diags := plan.Set(ctx, interfaceResourceModel{
		ID:               types.StringUnknown(),
		Name:             types.StringValue("primary-mcp"),
		Type:             types.StringValue("mcp.server"),
		Version:          types.StringValue("2025-11-25"),
		DocumentJSON:     types.StringValue(`{}`),
		Inputs:           types.MapNull(types.ObjectType{AttrTypes: interfaceInputAttrTypes}),
		Visibility:       types.StringValue("workspace"),
		ResourceURIInput: types.StringNull(),
		Labels:           types.MapNull(types.StringType),
		WorkspaceID:      types.StringUnknown(),
		CapsuleID:        types.StringUnknown(),
		Phase:            types.StringUnknown(),
		ResolvedRevision: types.Int64Unknown(),
	})
	if diags.HasError() {
		t.Fatalf("plan diagnostics: %v", diags)
	}
	resp := frameworkresource.CreateResponse{State: tfsdk.State{Schema: schemaResp.Schema}}
	r.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &resp)
	if !resp.Diagnostics.HasError() {
		t.Fatal("expected create to fail without ambient run identity")
	}
	found := false
	for _, d := range resp.Diagnostics.Errors() {
		detail := d.Detail()
		if strings.Contains(detail, envWorkspaceID) && strings.Contains(detail, envCapsuleID) && strings.Contains(detail, "in-run") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a clear in-run declaration message, got %v", resp.Diagnostics)
	}
}

func TestInterfaceCreateMapsRequestAndComputedState(t *testing.T) {
	setAmbientRunIdentity(t, "ws_1", "cap_1")
	ctx := context.Background()
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/interfaces" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode request: %v", err)
		}
		spec, _ := gotBody["spec"].(map[string]any)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-1-0"`)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 1, 0, "Pending", spec))
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	schemaResp := interfaceResourceSchemaResponse(t, r)
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	diags := plan.Set(ctx, interfaceResourceModel{
		ID:           types.StringUnknown(),
		Name:         types.StringValue("primary-mcp"),
		Type:         types.StringValue("mcp.server"),
		Version:      types.StringValue("2025-11-25"),
		DocumentJSON: types.StringValue(`{"transport":"streamable-http","display":{"title":"Example"}}`),
		Inputs: testInterfaceInputsMap(t, map[string]attr.Value{
			"endpoint": testInterfaceInput(t, map[string]attr.Value{
				"source":      types.StringValue("capsule_output"),
				"output_name": types.StringValue("mcp_url"),
			}),
			"note": testInterfaceInput(t, map[string]attr.Value{
				"source":     types.StringValue("literal"),
				"value_json": types.StringValue(`{"public":true}`),
			}),
		}),
		Visibility:       types.StringValue("workspace"),
		ResourceURIInput: types.StringValue("endpoint"),
		Labels:           types.MapNull(types.StringType),
		WorkspaceID:      types.StringUnknown(),
		CapsuleID:        types.StringUnknown(),
		Phase:            types.StringUnknown(),
		ResolvedRevision: types.Int64Unknown(),
	})
	if diags.HasError() {
		t.Fatalf("plan diagnostics: %v", diags)
	}
	resp := frameworkresource.CreateResponse{State: tfsdk.State{Schema: schemaResp.Schema}}
	r.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("create diagnostics: %v", resp.Diagnostics)
	}

	// Request carried the ambient identity and the Capsule owner.
	if gotBody["workspaceId"] != "ws_1" {
		t.Fatalf("expected ambient workspaceId, got %#v", gotBody["workspaceId"])
	}
	ownerRef, _ := gotBody["ownerRef"].(map[string]any)
	if ownerRef["kind"] != "Capsule" || ownerRef["id"] != "cap_1" {
		t.Fatalf("expected Capsule ownerRef from ambient identity, got %#v", ownerRef)
	}
	spec, _ := gotBody["spec"].(map[string]any)
	inputs, _ := spec["inputs"].(map[string]any)
	endpoint, _ := inputs["endpoint"].(map[string]any)
	if endpoint["capsuleId"] != "cap_1" {
		t.Fatalf("expected capsule_output capsuleId to default to the ambient Capsule, got %#v", endpoint)
	}
	note, _ := inputs["note"].(map[string]any)
	noteValue, _ := note["value"].(map[string]any)
	if noteValue["public"] != true {
		t.Fatalf("expected literal value carried as JSON, got %#v", note)
	}
	document, _ := spec["document"].(map[string]any)
	if document["transport"] != "streamable-http" {
		t.Fatalf("expected document object, got %#v", spec["document"])
	}

	// Computed state came from the server record.
	var state interfaceResourceModel
	if d := resp.State.Get(ctx, &state); d.HasError() {
		t.Fatalf("state diagnostics: %v", d)
	}
	if state.ID.ValueString() != "if_1" || state.WorkspaceID.ValueString() != "ws_1" || state.CapsuleID.ValueString() != "cap_1" {
		t.Fatalf("unexpected computed identity %#v", state)
	}
	if state.Phase.ValueString() != "Pending" || state.ResolvedRevision.ValueInt64() != 0 {
		t.Fatalf("unexpected computed status %#v", state)
	}
	// User-authored attributes stay exactly as planned.
	if state.DocumentJSON.ValueString() != `{"transport":"streamable-http","display":{"title":"Example"}}` {
		t.Fatalf("expected planned document_json kept verbatim, got %q", state.DocumentJSON.ValueString())
	}
}

func interfaceReadFixtureState(t *testing.T, r *interfaceResource) (tfsdk.State, interfaceResourceModel) {
	t.Helper()
	ctx := context.Background()
	schemaResp := interfaceResourceSchemaResponse(t, r)
	model := interfaceResourceModel{
		ID:      types.StringValue("if_1"),
		Name:    types.StringValue("primary-mcp"),
		Type:    types.StringValue("mcp.server"),
		Version: types.StringValue("2025-11-25"),
		// Deliberately different formatting and key order from the server's
		// canonical form.
		DocumentJSON: types.StringValue(`{"display": {"title": "Example"}, "transport": "streamable-http"}`),
		Inputs: testInterfaceInputsMap(t, map[string]attr.Value{
			"endpoint": testInterfaceInput(t, map[string]attr.Value{
				"source":      types.StringValue("capsule_output"),
				"output_name": types.StringValue("mcp_url"),
			}),
		}),
		Visibility:       types.StringValue("workspace"),
		ResourceURIInput: types.StringValue("endpoint"),
		Labels:           types.MapNull(types.StringType),
		WorkspaceID:      types.StringValue("ws_1"),
		CapsuleID:        types.StringValue("cap_1"),
		Phase:            types.StringValue("Pending"),
		ResolvedRevision: types.Int64Value(0),
	}
	state := tfsdk.State{Schema: schemaResp.Schema}
	if d := state.Set(ctx, model); d.HasError() {
		t.Fatalf("state diagnostics: %v", d)
	}
	return state, model
}

func interfaceReadServerSpec() map[string]any {
	return map[string]any{
		"type":     "mcp.server",
		"version":  "2025-11-25",
		"document": map[string]any{"transport": "streamable-http", "display": map[string]any{"title": "Example"}},
		"inputs": map[string]any{
			"endpoint": map[string]any{
				"source":     "capsule_output",
				"capsuleId":  "cap_1",
				"outputName": "mcp_url",
			},
		},
		"access": map[string]any{"visibility": "workspace", "resourceUriInput": "endpoint"},
	}
}

func TestInterfaceReadKeepsSemanticallyEqualUserSpec(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/interfaces/if_1" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-1-2"`)
		_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 1, 2, "Resolved", interfaceReadServerSpec()))
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	state, model := interfaceReadFixtureState(t, r)
	resp := frameworkresource.ReadResponse{State: state}
	r.Read(ctx, frameworkresource.ReadRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("read diagnostics: %v", resp.Diagnostics)
	}
	var got interfaceResourceModel
	if d := resp.State.Get(ctx, &got); d.HasError() {
		t.Fatalf("state diagnostics: %v", d)
	}
	// User formatting kept verbatim: the server record is semantically equal.
	if got.DocumentJSON.ValueString() != model.DocumentJSON.ValueString() {
		t.Fatalf("expected user document_json kept, got %q", got.DocumentJSON.ValueString())
	}
	// The omitted capsule_id stays omitted even though the server stores the
	// ambient Capsule id.
	inputs := map[string]interfaceInputModel{}
	if d := got.Inputs.ElementsAs(ctx, &inputs, false); d.HasError() {
		t.Fatalf("inputs diagnostics: %v", d)
	}
	if !inputs["endpoint"].CapsuleID.IsNull() {
		t.Fatalf("expected omitted capsule_id kept null, got %q", inputs["endpoint"].CapsuleID.ValueString())
	}
	// Computed status refreshed.
	if got.Phase.ValueString() != "Resolved" || got.ResolvedRevision.ValueInt64() != 2 {
		t.Fatalf("expected refreshed status, got %#v", got)
	}
}

func TestInterfaceReadProjectsServerDrift(t *testing.T) {
	ctx := context.Background()
	spec := interfaceReadServerSpec()
	spec["version"] = "2026-01-01"
	spec["document"] = map[string]any{"transport": "sse"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-2-3"`)
		_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 3, "Resolved", spec))
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	state, _ := interfaceReadFixtureState(t, r)
	resp := frameworkresource.ReadResponse{State: state}
	r.Read(ctx, frameworkresource.ReadRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("read diagnostics: %v", resp.Diagnostics)
	}
	var got interfaceResourceModel
	if d := resp.State.Get(ctx, &got); d.HasError() {
		t.Fatalf("state diagnostics: %v", d)
	}
	if got.Version.ValueString() != "2026-01-01" {
		t.Fatalf("expected drifted version projected, got %q", got.Version.ValueString())
	}
	if got.DocumentJSON.ValueString() != `{"transport":"sse"}` {
		t.Fatalf("expected drifted document projected canonically, got %q", got.DocumentJSON.ValueString())
	}
}

func TestInterfaceReadNotFoundRemovesResource(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"Interface not found"}}`))
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	state, _ := interfaceReadFixtureState(t, r)
	resp := frameworkresource.ReadResponse{State: state}
	r.Read(ctx, frameworkresource.ReadRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("read diagnostics: %v", resp.Diagnostics)
	}
	if !resp.State.Raw.IsNull() {
		t.Fatal("expected resource removed from state on 404")
	}
}

func TestInterfaceUpdateUsesFreshETag(t *testing.T) {
	setAmbientRunIdentity(t, "ws_1", "cap_1")
	ctx := context.Background()
	var patched map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/interfaces/if_1":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-2-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 3, "Resolved", interfaceReadServerSpec()))
		case r.Method == http.MethodPatch && r.URL.Path == "/v1/interfaces/if_1":
			if got := r.Header.Get("If-Match"); got != `"if-2-3"` {
				t.Errorf("expected If-Match from the fresh GET, got %q", got)
			}
			if err := json.NewDecoder(r.Body).Decode(&patched); err != nil {
				t.Errorf("decode request: %v", err)
			}
			spec, _ := patched["spec"].(map[string]any)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-3-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 3, 3, "Resolved", spec))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	schemaResp := interfaceResourceSchemaResponse(t, r)
	state, model := interfaceReadFixtureState(t, r)
	planModel := model
	planModel.DocumentJSON = types.StringValue(`{"transport":"sse"}`)
	planModel.Phase = types.StringUnknown()
	planModel.ResolvedRevision = types.Int64Unknown()
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	if d := plan.Set(ctx, planModel); d.HasError() {
		t.Fatalf("plan diagnostics: %v", d)
	}
	resp := frameworkresource.UpdateResponse{State: tfsdk.State{Schema: schemaResp.Schema}}
	r.Update(ctx, frameworkresource.UpdateRequest{Plan: plan, State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("update diagnostics: %v", resp.Diagnostics)
	}
	if patched["name"] != "primary-mcp" {
		t.Fatalf("expected name in PATCH body, got %#v", patched["name"])
	}
	spec, _ := patched["spec"].(map[string]any)
	document, _ := spec["document"].(map[string]any)
	if document["transport"] != "sse" {
		t.Fatalf("expected updated document in PATCH body, got %#v", spec)
	}
	inputs, _ := spec["inputs"].(map[string]any)
	endpoint, _ := inputs["endpoint"].(map[string]any)
	if endpoint["capsuleId"] != "cap_1" {
		t.Fatalf("expected ambient capsule fill on update, got %#v", endpoint)
	}
	var got interfaceResourceModel
	if d := resp.State.Get(ctx, &got); d.HasError() {
		t.Fatalf("state diagnostics: %v", d)
	}
	if got.Phase.ValueString() != "Resolved" || got.ResolvedRevision.ValueInt64() != 3 {
		t.Fatalf("expected refreshed computed status, got %#v", got)
	}
	if got.DocumentJSON.ValueString() != `{"transport":"sse"}` {
		t.Fatalf("expected planned document kept, got %q", got.DocumentJSON.ValueString())
	}
}

func TestInterfaceDeleteUsesFreshETag(t *testing.T) {
	ctx := context.Background()
	deleted := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/interfaces/if_1":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-2-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 3, "Resolved", interfaceReadServerSpec()))
		case r.Method == http.MethodDelete && r.URL.Path == "/v1/interfaces/if_1":
			if got := r.Header.Get("If-Match"); got != `"if-2-3"` {
				t.Errorf("expected If-Match from the fresh GET, got %q", got)
			}
			deleted = true
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 3, 3, "Retired", interfaceReadServerSpec()))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	state, _ := interfaceReadFixtureState(t, r)
	resp := frameworkresource.DeleteResponse{}
	r.Delete(ctx, frameworkresource.DeleteRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("delete diagnostics: %v", resp.Diagnostics)
	}
	if !deleted {
		t.Fatal("expected DELETE request")
	}
}

func serverSpecWithPolicyRef(policyRef string) map[string]any {
	spec := interfaceReadServerSpec()
	access, _ := spec["access"].(map[string]any)
	access["policyRef"] = policyRef
	return spec
}

func emptyInterfaceResourceModel() interfaceResourceModel {
	return interfaceResourceModel{
		ID:               types.StringNull(),
		Name:             types.StringNull(),
		Type:             types.StringNull(),
		Version:          types.StringNull(),
		DocumentJSON:     types.StringNull(),
		Inputs:           types.MapNull(types.ObjectType{AttrTypes: interfaceInputAttrTypes}),
		Visibility:       types.StringNull(),
		ResourceURIInput: types.StringNull(),
		PolicyRef:        types.StringNull(),
		Labels:           types.MapNull(types.StringType),
		WorkspaceID:      types.StringNull(),
		CapsuleID:        types.StringNull(),
		Phase:            types.StringNull(),
		ResolvedRevision: types.Int64Null(),
	}
}

// F1: a retired Interface record stays readable; Read must treat it as gone so
// the next apply plans a fresh create (freed by the active-name unique index).
func TestInterfaceReadRetiredRemovesResource(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-4-4"`)
		_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 4, 4, "Retired", interfaceReadServerSpec()))
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	state, _ := interfaceReadFixtureState(t, r)
	resp := frameworkresource.ReadResponse{State: state}
	r.Read(ctx, frameworkresource.ReadRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("read diagnostics: %v", resp.Diagnostics)
	}
	if !resp.State.Raw.IsNull() {
		t.Fatal("expected a retired Interface to be removed from state")
	}
}

// F4: an operator can attach an access Policy out-of-band; Read projects it.
func TestInterfaceReadProjectsOutOfBandPolicyRef(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"if-2-2"`)
		_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 2, "Resolved", serverSpecWithPolicyRef("pol_out_of_band")))
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	state, _ := interfaceReadFixtureState(t, r)
	resp := frameworkresource.ReadResponse{State: state}
	r.Read(ctx, frameworkresource.ReadRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("read diagnostics: %v", resp.Diagnostics)
	}
	var got interfaceResourceModel
	if d := resp.State.Get(ctx, &got); d.HasError() {
		t.Fatalf("state diagnostics: %v", d)
	}
	if got.PolicyRef.ValueString() != "pol_out_of_band" {
		t.Fatalf("expected out-of-band policy_ref projected into state, got %q", got.PolicyRef.ValueString())
	}
}

// F4: an update that does not author policy_ref must carry the server's current
// policyRef into the PATCH instead of silently clearing it.
func TestInterfaceUpdatePreservesOutOfBandPolicyRef(t *testing.T) {
	setAmbientRunIdentity(t, "ws_1", "cap_1")
	ctx := context.Background()
	var patched map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/interfaces/if_1":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-2-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 3, "Resolved", serverSpecWithPolicyRef("pol_1")))
		case r.Method == http.MethodPatch && r.URL.Path == "/v1/interfaces/if_1":
			if err := json.NewDecoder(r.Body).Decode(&patched); err != nil {
				t.Errorf("decode request: %v", err)
			}
			spec, _ := patched["spec"].(map[string]any)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-3-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 3, 3, "Resolved", spec))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	schemaResp := interfaceResourceSchemaResponse(t, r)
	state, model := interfaceReadFixtureState(t, r)
	planModel := model
	planModel.DocumentJSON = types.StringValue(`{"transport":"sse"}`)
	planModel.PolicyRef = types.StringNull() // module does not author policy_ref
	planModel.Phase = types.StringUnknown()
	planModel.ResolvedRevision = types.Int64Unknown()
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	if d := plan.Set(ctx, planModel); d.HasError() {
		t.Fatalf("plan diagnostics: %v", d)
	}
	resp := frameworkresource.UpdateResponse{State: tfsdk.State{Schema: schemaResp.Schema}}
	r.Update(ctx, frameworkresource.UpdateRequest{Plan: plan, State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("update diagnostics: %v", resp.Diagnostics)
	}
	spec, _ := patched["spec"].(map[string]any)
	access, _ := spec["access"].(map[string]any)
	if access["policyRef"] != "pol_1" {
		t.Fatalf("expected out-of-band policyRef carried into PATCH, got %#v", access)
	}
	var got interfaceResourceModel
	if d := resp.State.Get(ctx, &got); d.HasError() {
		t.Fatalf("state diagnostics: %v", d)
	}
	if got.PolicyRef.ValueString() != "pol_1" {
		t.Fatalf("expected preserved policy_ref in state, got %q", got.PolicyRef.ValueString())
	}
}

// F3: a transient precondition failure retries with a fresh read and succeeds.
func TestInterfaceUpdateRetriesOnPreconditionFailure(t *testing.T) {
	setAmbientRunIdentity(t, "ws_1", "cap_1")
	ctx := context.Background()
	patchAttempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-2-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 3, "Resolved", interfaceReadServerSpec()))
		case http.MethodPatch:
			patchAttempts++
			if patchAttempts == 1 {
				w.WriteHeader(http.StatusPreconditionFailed)
				_, _ = w.Write([]byte(`{"error":{"code":"failed_precondition","message":"If-Match must equal the current Interface ETag"}}`))
				return
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			spec, _ := body["spec"].(map[string]any)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-3-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 3, 3, "Resolved", spec))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	schemaResp := interfaceResourceSchemaResponse(t, r)
	state, model := interfaceReadFixtureState(t, r)
	planModel := model
	planModel.DocumentJSON = types.StringValue(`{"transport":"sse"}`)
	planModel.Phase = types.StringUnknown()
	planModel.ResolvedRevision = types.Int64Unknown()
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	if d := plan.Set(ctx, planModel); d.HasError() {
		t.Fatalf("plan diagnostics: %v", d)
	}
	resp := frameworkresource.UpdateResponse{State: tfsdk.State{Schema: schemaResp.Schema}}
	r.Update(ctx, frameworkresource.UpdateRequest{Plan: plan, State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("update diagnostics: %v", resp.Diagnostics)
	}
	if patchAttempts != 2 {
		t.Fatalf("expected a retry after 412, got %d PATCH attempts", patchAttempts)
	}
}

// F3: after exhausting retries the update reports a transient, re-appliable error.
func TestInterfaceUpdateGivesUpAfterRetries(t *testing.T) {
	setAmbientRunIdentity(t, "ws_1", "cap_1")
	ctx := context.Background()
	patchAttempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-2-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 3, "Resolved", interfaceReadServerSpec()))
		case http.MethodPatch:
			patchAttempts++
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"Interface changed concurrently"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	schemaResp := interfaceResourceSchemaResponse(t, r)
	state, model := interfaceReadFixtureState(t, r)
	planModel := model
	planModel.DocumentJSON = types.StringValue(`{"transport":"sse"}`)
	planModel.Phase = types.StringUnknown()
	planModel.ResolvedRevision = types.Int64Unknown()
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	if d := plan.Set(ctx, planModel); d.HasError() {
		t.Fatalf("plan diagnostics: %v", d)
	}
	resp := frameworkresource.UpdateResponse{State: tfsdk.State{Schema: schemaResp.Schema}}
	r.Update(ctx, frameworkresource.UpdateRequest{Plan: plan, State: state}, &resp)
	if !resp.Diagnostics.HasError() {
		t.Fatal("expected an error after exhausting retries")
	}
	if patchAttempts != interfaceWriteMaxAttempts {
		t.Fatalf("expected %d PATCH attempts, got %d", interfaceWriteMaxAttempts, patchAttempts)
	}
	found := false
	for _, d := range resp.Diagnostics.Errors() {
		if strings.Contains(d.Detail(), "re-apply") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a transient/re-apply hint, got %v", resp.Diagnostics)
	}
}

// F3: Delete retries a transient precondition failure with a fresh read.
func TestInterfaceDeleteRetriesOnConflict(t *testing.T) {
	ctx := context.Background()
	deleteAttempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-2-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 3, "Resolved", interfaceReadServerSpec()))
		case http.MethodDelete:
			deleteAttempts++
			if deleteAttempts == 1 {
				w.WriteHeader(http.StatusPreconditionFailed)
				_, _ = w.Write([]byte(`{"error":{"code":"failed_precondition","message":"stale"}}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 3, 3, "Retired", interfaceReadServerSpec()))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	state, _ := interfaceReadFixtureState(t, r)
	resp := frameworkresource.DeleteResponse{}
	r.Delete(ctx, frameworkresource.DeleteRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("delete diagnostics: %v", resp.Diagnostics)
	}
	if deleteAttempts != 2 {
		t.Fatalf("expected a retry after 412, got %d DELETE attempts", deleteAttempts)
	}
}

// F6: If-Match is derived locally from the record, immune to a proxy that
// weakens the response ETag validator.
func TestInterfaceUpdateDerivesETagLocally(t *testing.T) {
	setAmbientRunIdentity(t, "ws_1", "cap_1")
	ctx := context.Background()
	var ifMatch string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// A proxy weakened the strong validator to a weak one.
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `W/"if-2-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 2, 3, "Resolved", interfaceReadServerSpec()))
		case http.MethodPatch:
			ifMatch = r.Header.Get("If-Match")
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			spec, _ := body["spec"].(map[string]any)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"if-3-3"`)
			_ = json.NewEncoder(w).Encode(testInterfaceServerRecord("if_1", "primary-mcp", 3, 3, "Resolved", spec))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	schemaResp := interfaceResourceSchemaResponse(t, r)
	state, model := interfaceReadFixtureState(t, r)
	planModel := model
	planModel.DocumentJSON = types.StringValue(`{"transport":"sse"}`)
	planModel.Phase = types.StringUnknown()
	planModel.ResolvedRevision = types.Int64Unknown()
	plan := tfsdk.Plan{Schema: schemaResp.Schema}
	if d := plan.Set(ctx, planModel); d.HasError() {
		t.Fatalf("plan diagnostics: %v", d)
	}
	resp := frameworkresource.UpdateResponse{State: tfsdk.State{Schema: schemaResp.Schema}}
	r.Update(ctx, frameworkresource.UpdateRequest{Plan: plan, State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("update diagnostics: %v", resp.Diagnostics)
	}
	if ifMatch != `"if-2-3"` {
		t.Fatalf("expected locally derived strong If-Match, got %q", ifMatch)
	}
}

// F5: import adopts an existing Interface by id (crash recovery for a create
// that persisted the record but not the state).
func TestInterfaceImportStateSetsID(t *testing.T) {
	ctx := context.Background()
	r := &interfaceResource{}
	schemaResp := interfaceResourceSchemaResponse(t, r)
	state := tfsdk.State{Schema: schemaResp.Schema}
	if d := state.Set(ctx, emptyInterfaceResourceModel()); d.HasError() {
		t.Fatalf("seed state: %v", d)
	}
	resp := frameworkresource.ImportStateResponse{State: state}
	r.ImportState(ctx, frameworkresource.ImportStateRequest{ID: "if_1"}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("import diagnostics: %v", resp.Diagnostics)
	}
	var got interfaceResourceModel
	if d := resp.State.Get(ctx, &got); d.HasError() {
		t.Fatalf("state diagnostics: %v", d)
	}
	if got.ID.ValueString() != "if_1" {
		t.Fatalf("expected imported id, got %q", got.ID.ValueString())
	}
}

func TestInterfaceResourceSupportsImportState(t *testing.T) {
	if _, ok := NewInterfaceResource().(frameworkresource.ResourceWithImportState); !ok {
		t.Fatal("takosumi_interface must support import for crash recovery")
	}
}

func TestInterfaceDeleteToleratesAlreadyGone(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected only the fresh GET, got %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"Interface not found"}}`))
	}))
	defer srv.Close()

	r := &interfaceResource{data: &providerData{client: client.New(srv.URL, "run-token", srv.Client())}}
	state, _ := interfaceReadFixtureState(t, r)
	resp := frameworkresource.DeleteResponse{}
	r.Delete(ctx, frameworkresource.DeleteRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("expected already-gone delete to succeed, got %v", resp.Diagnostics)
	}
}
