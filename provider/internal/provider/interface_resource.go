package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

// Ambient run identity the Takosumi runner injects into a Capsule's OpenTofu
// environment alongside TAKOSUMI_ENDPOINT / TAKOSUMI_TOKEN (the Capsule-scoped
// run token the provider already reads as endpoint/token fallbacks).
const (
	envWorkspaceID = "TAKOSUMI_WORKSPACE_ID"
	envCapsuleID   = "TAKOSUMI_CAPSULE_ID"
)

const (
	interfaceOwnerKindCapsule  = "Capsule"
	interfaceSourceLiteral     = "literal"
	interfaceSourceCapsule     = "capsule_output"
	interfaceSourceResource    = "resource_output"
	interfaceDefaultVisibility = "workspace"
	// interfacePhaseRetired is the terminal phase the server reports for a
	// retired (deleted) Interface. The record stays readable, so Read must
	// treat it as gone rather than as live drift.
	interfacePhaseRetired = "Retired"
	// interfaceWriteMaxAttempts bounds the fresh-GET -> PATCH/DELETE optimistic
	// concurrency retry loop when the server reports a precondition/conflict.
	interfaceWriteMaxAttempts = 3
)

var (
	_ resource.Resource                = (*interfaceResource)(nil)
	_ resource.ResourceWithConfigure   = (*interfaceResource)(nil)
	_ resource.ResourceWithImportState = (*interfaceResource)(nil)
)

type interfaceResource struct {
	data *providerData
}

func NewInterfaceResource() resource.Resource {
	return &interfaceResource{}
}

type interfaceResourceModel struct {
	ID               types.String `tfsdk:"id"`
	Name             types.String `tfsdk:"name"`
	Type             types.String `tfsdk:"type"`
	Version          types.String `tfsdk:"version"`
	DocumentJSON     types.String `tfsdk:"document_json"`
	Inputs           types.Map    `tfsdk:"inputs"`
	Visibility       types.String `tfsdk:"visibility"`
	ResourceURIInput types.String `tfsdk:"resource_uri_input"`
	PolicyRef        types.String `tfsdk:"policy_ref"`
	Labels           types.Map    `tfsdk:"labels"`
	WorkspaceID      types.String `tfsdk:"workspace_id"`
	CapsuleID        types.String `tfsdk:"capsule_id"`
	Phase            types.String `tfsdk:"phase"`
	ResolvedRevision types.Int64  `tfsdk:"resolved_revision"`
}

type interfaceInputModel struct {
	Source     types.String `tfsdk:"source"`
	OutputName types.String `tfsdk:"output_name"`
	CapsuleID  types.String `tfsdk:"capsule_id"`
	ResourceID types.String `tfsdk:"resource_id"`
	Pointer    types.String `tfsdk:"pointer"`
	ValueJSON  types.String `tfsdk:"value_json"`
}

var interfaceInputAttrTypes = map[string]attr.Type{
	"source":      types.StringType,
	"output_name": types.StringType,
	"capsule_id":  types.StringType,
	"resource_id": types.StringType,
	"pointer":     types.StringType,
	"value_json":  types.StringType,
}

func (r *interfaceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_interface"
}

func (r *interfaceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Declares this module's own Takosumi `Interface` (for example an MCP server surface) " +
			"during the Capsule's own Takosumi Run. The runner injects the ambient identity " +
			"(`TAKOSUMI_WORKSPACE_ID`, `TAKOSUMI_CAPSULE_ID`) and a Capsule-scoped run credential " +
			"(`TAKOSUMI_ENDPOINT`, `TAKOSUMI_TOKEN`), so the Interface is always owned by the declaring Capsule. " +
			"This resource never creates or manages `InterfaceBinding` records: consumer authorization stays a " +
			"service-side, user-approved decision outside the module.",
		Attributes: map[string]schema.Attribute{
			"name": schema.StringAttribute{
				Required:    true,
				Description: "Interface name, unique within the Workspace.",
				Validators:  []validator.String{StringToken()},
			},
			"type": schema.StringAttribute{
				Required:    true,
				Description: "Interface type token, e.g. mcp.server.",
				Validators:  []validator.String{StringToken()},
			},
			"version": schema.StringAttribute{
				Required:    true,
				Description: "Interface type version, e.g. 2025-11-25.",
				Validators:  []validator.String{StringToken()},
			},
			"document_json": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Default:     stringdefault.StaticString("{}"),
				Description: "Non-secret Interface document as a JSON object string, e.g. jsonencode({...}). Never place credentials here.",
				Validators:  []validator.String{StringJSONObject()},
			},
			"inputs": schema.MapNestedAttribute{
				Optional: true,
				Description: "Named public inputs resolved by Takosumi. source is one of literal (value_json), " +
					"capsule_output (output_name, optional capsule_id and pointer), or resource_output (resource_id, " +
					"output_name, optional pointer). A capsule_output input without capsule_id reads this Capsule's own OpenTofu Output.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"source": schema.StringAttribute{
							Required:    true,
							Description: "Input source: literal, capsule_output, or resource_output.",
							Validators: []validator.String{
								StringOneOf(interfaceSourceLiteral, interfaceSourceCapsule, interfaceSourceResource),
							},
						},
						"output_name": schema.StringAttribute{
							Optional:    true,
							Description: "Output name for capsule_output / resource_output inputs.",
						},
						"capsule_id": schema.StringAttribute{
							Optional:    true,
							Description: "Capsule id for capsule_output inputs. Defaults to the ambient Capsule (this module's own Run).",
						},
						"resource_id": schema.StringAttribute{
							Optional:    true,
							Description: "Resource id for resource_output inputs.",
						},
						"pointer": schema.StringAttribute{
							Optional:    true,
							Description: "Optional RFC 6901 JSON pointer into the referenced output value.",
						},
						"value_json": schema.StringAttribute{
							Optional:    true,
							Description: "Literal public JSON value for literal inputs, e.g. jsonencode(...).",
							Validators:  []validator.String{StringJSON()},
						},
					},
				},
			},
			"visibility": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Default:     stringdefault.StaticString(interfaceDefaultVisibility),
				Description: "Access visibility: private, workspace, or public.",
				Validators:  []validator.String{StringOneOf("private", "workspace", "public")},
			},
			"resource_uri_input": schema.StringAttribute{
				Optional:    true,
				Description: "Input name whose resolved value is the token audience / resource URI.",
			},
			"policy_ref": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Description: "Optional access Policy reference that gates resolution. When left unset, an operator " +
					"may attach a Policy out-of-band and the provider preserves it on later updates instead of " +
					"silently clearing it.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"labels": schema.MapAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Optional string labels.",
			},
			"id": schema.StringAttribute{
				Computed:    true,
				Description: "Takosumi Interface identifier.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"workspace_id": schema.StringAttribute{
				Computed:    true,
				Description: "Workspace id taken from the ambient " + envWorkspaceID + " run identity.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"capsule_id": schema.StringAttribute{
				Computed:    true,
				Description: "Owning Capsule id taken from the ambient " + envCapsuleID + " run identity.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"phase": schema.StringAttribute{
				Computed:    true,
				Description: "Observed Interface phase, e.g. Pending or Resolved.",
			},
			"resolved_revision": schema.Int64Attribute{
				Computed:    true,
				Description: "Observed resolved-input revision.",
			},
		},
	}
}

func (r *interfaceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	data, ok := req.ProviderData.(*providerData)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected provider data",
			fmt.Sprintf("Expected *providerData, got %T. This is a provider bug.", req.ProviderData),
		)
		return
	}
	r.data = data
}

func (r *interfaceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan interfaceResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	workspaceID, capsuleID := ambientRunIdentity()
	if workspaceID == "" || capsuleID == "" {
		resp.Diagnostics.AddError(
			"Missing ambient Takosumi run identity",
			"takosumi_interface is designed for in-run declaration: the Takosumi runner injects "+
				envWorkspaceID+" and "+envCapsuleID+" (with TAKOSUMI_ENDPOINT and the Capsule-scoped "+
				"TAKOSUMI_TOKEN) into the OpenTofu environment of the Capsule's own Run, and the Interface "+
				"is owned by that Capsule. One or both variables are missing, so this apply is not running "+
				"as a Takosumi Capsule Run. Install this module as a Takosumi Capsule, or remove the "+
				"takosumi_interface resource.",
		)
		return
	}
	body, d := plan.toCreateRequest(ctx, workspaceID, capsuleID)
	resp.Diagnostics.Append(d...)
	if resp.Diagnostics.HasError() {
		return
	}
	record, _, err := r.data.client.CreateInterface(ctx, body)
	if err != nil {
		resp.Diagnostics.AddError("Failed to create Interface", err.Error())
		return
	}
	applyInterfaceRecord(record, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *interfaceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state interfaceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	record, _, err := r.data.client.GetInterface(ctx, state.ID.ValueString())
	if err != nil {
		if errors.Is(err, client.ErrNotFound) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Failed to read Interface", err.Error())
		return
	}
	// A retired Interface record stays readable but is logically gone: retire
	// keeps the row (with its spec) so a plain GET still returns it. Treat it
	// like a 404 so OpenTofu plans a fresh create. The active-name partial
	// unique index frees the name once the record is Retired, so re-create
	// succeeds.
	if record.Status.Phase == interfacePhaseRetired {
		resp.State.RemoveResource(ctx)
		return
	}
	resp.Diagnostics.Append(refreshInterfaceState(ctx, record, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *interfaceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan interfaceResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	var state interfaceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// The owner never changes on update; the ambient Capsule id (or, as a
	// fallback, the recorded owner) fills capsule_output inputs.
	_, capsuleID := ambientRunIdentity()
	if capsuleID == "" && !state.CapsuleID.IsNull() && !state.CapsuleID.IsUnknown() {
		capsuleID = state.CapsuleID.ValueString()
	}
	id := state.ID.ValueString()

	var record *client.InterfaceRecord
	var lastErr error
	for attempt := 0; attempt < interfaceWriteMaxAttempts; attempt++ {
		// PATCH requires If-Match to equal the current ETag; read it fresh and
		// derive the tag locally (see interfaceETag) so an ETag-rewriting proxy
		// cannot cause a permanent precondition failure.
		current, _, err := r.data.client.GetInterface(ctx, id)
		if err != nil {
			resp.Diagnostics.AddError("Failed to read Interface before update", err.Error())
			return
		}
		// Preserve an out-of-band access Policy: if the module does not author
		// policy_ref, carry whatever the server currently records so the PATCH
		// never clears it.
		policyRef := plan.configuredPolicyRef()
		if policyRef == "" {
			policyRef = current.Spec.Access.PolicyRef
		}
		spec, d := plan.toSpec(ctx, capsuleID, policyRef)
		resp.Diagnostics.Append(d...)
		if resp.Diagnostics.HasError() {
			return
		}
		labels := map[string]string{}
		if !plan.Labels.IsNull() && !plan.Labels.IsUnknown() {
			resp.Diagnostics.Append(plan.Labels.ElementsAs(ctx, &labels, false)...)
			if resp.Diagnostics.HasError() {
				return
			}
		}
		body := &client.UpdateInterfaceRequest{
			Name:   plan.Name.ValueString(),
			Labels: &labels,
			Spec:   spec,
		}
		updated, _, err := r.data.client.UpdateInterface(ctx, id, interfaceETag(current), body)
		if err == nil {
			record = updated
			break
		}
		lastErr = err
		if !isRetryableInterfaceConflict(err) {
			resp.Diagnostics.AddError("Failed to update Interface", err.Error())
			return
		}
	}
	if record == nil {
		resp.Diagnostics.AddError(
			"Failed to update Interface after retrying optimistic concurrency",
			"The Interface changed on the server between the fresh read and the PATCH on every attempt "+
				"(If-Match precondition or generation/revision conflict). This is transient; re-apply to "+
				"retry. Last error: "+errString(lastErr),
		)
		return
	}
	applyInterfaceRecord(record, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *interfaceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state interfaceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()
	var lastErr error
	for attempt := 0; attempt < interfaceWriteMaxAttempts; attempt++ {
		// DELETE requires If-Match to equal the current ETag; read it fresh and
		// derive the tag locally so an ETag-rewriting proxy cannot wedge the
		// destroy on a permanent precondition failure.
		current, _, err := r.data.client.GetInterface(ctx, id)
		if err != nil {
			if errors.Is(err, client.ErrNotFound) {
				return
			}
			resp.Diagnostics.AddError("Failed to read Interface before delete", err.Error())
			return
		}
		err = r.data.client.DeleteInterface(ctx, id, interfaceETag(current))
		if err == nil {
			return
		}
		lastErr = err
		if !isRetryableInterfaceConflict(err) {
			resp.Diagnostics.AddError("Failed to delete Interface", err.Error())
			return
		}
	}
	resp.Diagnostics.AddError(
		"Failed to delete Interface after retrying optimistic concurrency",
		"The Interface changed on the server between the fresh read and the DELETE on every attempt "+
			"(If-Match precondition or generation/revision conflict). This is transient; re-apply to retry. "+
			"Last error: "+errString(lastErr),
	)
}

// ImportState adopts an existing Interface by id. A later Read fully hydrates
// the remaining attributes from the server record. Import is the recovery path
// when a create persisted the record but the run crashed before writing state,
// which would otherwise wedge on already_exists.
func (r *interfaceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}

func (r *interfaceResource) assertConfigured(diags *diag.Diagnostics) bool {
	if r.data == nil || r.data.client == nil {
		diags.AddError("Provider not configured", "Configure the Takosumi provider before using this resource.")
		return false
	}
	return true
}

// ambientRunIdentity reads the Workspace / Capsule identity the Takosumi
// runner injects into the Capsule's own OpenTofu Run.
func ambientRunIdentity() (workspaceID, capsuleID string) {
	return strings.TrimSpace(os.Getenv(envWorkspaceID)), strings.TrimSpace(os.Getenv(envCapsuleID))
}

func (m interfaceResourceModel) toCreateRequest(ctx context.Context, workspaceID, capsuleID string) (*client.CreateInterfaceRequest, diag.Diagnostics) {
	var diags diag.Diagnostics
	// No prior server record on create; only an explicitly authored policy_ref
	// is sent.
	spec, d := m.toSpec(ctx, capsuleID, m.configuredPolicyRef())
	diags.Append(d...)
	if diags.HasError() {
		return nil, diags
	}
	body := &client.CreateInterfaceRequest{
		WorkspaceID: workspaceID,
		Name:        m.Name.ValueString(),
		OwnerRef:    client.InterfaceOwnerRef{Kind: interfaceOwnerKindCapsule, ID: capsuleID},
		Spec:        *spec,
	}
	if !m.Labels.IsNull() && !m.Labels.IsUnknown() {
		labels := map[string]string{}
		diags.Append(m.Labels.ElementsAs(ctx, &labels, false)...)
		if diags.HasError() {
			return nil, diags
		}
		body.Labels = labels
	}
	return body, diags
}

// configuredPolicyRef returns the module-authored access Policy reference, or
// "" when the attribute is unset/unknown (leaving the server value authoritative).
func (m interfaceResourceModel) configuredPolicyRef() string {
	if m.PolicyRef.IsNull() || m.PolicyRef.IsUnknown() {
		return ""
	}
	return strings.TrimSpace(m.PolicyRef.ValueString())
}

func (m interfaceResourceModel) toSpec(ctx context.Context, ambientCapsuleID, policyRef string) (*client.InterfaceSpec, diag.Diagnostics) {
	var diags diag.Diagnostics
	documentRaw := "{}"
	if !m.DocumentJSON.IsNull() && !m.DocumentJSON.IsUnknown() && strings.TrimSpace(m.DocumentJSON.ValueString()) != "" {
		documentRaw = m.DocumentJSON.ValueString()
	}
	// The module-authored document is constrained to a JSON object even though
	// the transport carries any JSON value; validate that here.
	var document map[string]any
	if err := json.Unmarshal([]byte(documentRaw), &document); err != nil || document == nil {
		diags.AddAttributeError(
			path.Root("document_json"),
			"Invalid document JSON",
			"document_json must be a JSON object, e.g. jsonencode({...}).",
		)
		return nil, diags
	}
	visibility := interfaceDefaultVisibility
	if !m.Visibility.IsNull() && !m.Visibility.IsUnknown() && m.Visibility.ValueString() != "" {
		visibility = m.Visibility.ValueString()
	}
	spec := &client.InterfaceSpec{
		Type:     m.Type.ValueString(),
		Version:  m.Version.ValueString(),
		Document: json.RawMessage(documentRaw),
		Access:   client.InterfaceAccess{Visibility: visibility},
	}
	if !m.ResourceURIInput.IsNull() && !m.ResourceURIInput.IsUnknown() && m.ResourceURIInput.ValueString() != "" {
		spec.Access.ResourceURIInput = m.ResourceURIInput.ValueString()
	}
	if policyRef != "" {
		spec.Access.PolicyRef = policyRef
	}
	if !m.Inputs.IsNull() && !m.Inputs.IsUnknown() {
		raw := map[string]interfaceInputModel{}
		diags.Append(m.Inputs.ElementsAs(ctx, &raw, false)...)
		if diags.HasError() {
			return nil, diags
		}
		inputs := make(map[string]client.InterfaceInput, len(raw))
		for name, input := range raw {
			wire, d := input.toWire(name, ambientCapsuleID)
			diags.Append(d...)
			if d.HasError() {
				continue
			}
			inputs[name] = wire
		}
		if diags.HasError() {
			return nil, diags
		}
		if len(inputs) > 0 {
			spec.Inputs = inputs
		}
	}
	return spec, diags
}

func (in interfaceInputModel) toWire(name, ambientCapsuleID string) (client.InterfaceInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	inputPath := path.Root("inputs").AtMapKey(name)
	value := func(v types.String) string {
		if v.IsNull() || v.IsUnknown() {
			return ""
		}
		return v.ValueString()
	}
	source := value(in.Source)
	valueJSON := value(in.ValueJSON)
	outputName := value(in.OutputName)
	capsuleID := value(in.CapsuleID)
	resourceID := value(in.ResourceID)
	pointer := value(in.Pointer)
	wire := client.InterfaceInput{Source: source}
	switch source {
	case interfaceSourceLiteral:
		if valueJSON == "" {
			diags.AddAttributeError(inputPath, "Missing literal value", "a literal input requires value_json.")
			return wire, diags
		}
		if !json.Valid([]byte(valueJSON)) {
			diags.AddAttributeError(inputPath, "Invalid literal value", "value_json must be valid JSON, e.g. produced by jsonencode(...).")
			return wire, diags
		}
		if outputName != "" || capsuleID != "" || resourceID != "" || pointer != "" {
			diags.AddAttributeError(inputPath, "Invalid literal input", "a literal input takes only value_json.")
			return wire, diags
		}
		wire.Value = json.RawMessage(valueJSON)
	case interfaceSourceCapsule:
		if outputName == "" {
			diags.AddAttributeError(inputPath, "Missing output name", "a capsule_output input requires output_name.")
			return wire, diags
		}
		if valueJSON != "" || resourceID != "" {
			diags.AddAttributeError(inputPath, "Invalid capsule_output input", "a capsule_output input takes output_name, optional capsule_id, and optional pointer.")
			return wire, diags
		}
		if capsuleID == "" {
			capsuleID = ambientCapsuleID
		}
		if capsuleID == "" {
			diags.AddAttributeError(inputPath, "Missing capsule id", "set capsule_id or run inside a Takosumi Run where "+envCapsuleID+" identifies this Capsule.")
			return wire, diags
		}
		wire.CapsuleID = capsuleID
		wire.OutputName = outputName
		wire.Pointer = pointer
	case interfaceSourceResource:
		if resourceID == "" || outputName == "" {
			diags.AddAttributeError(inputPath, "Missing resource output reference", "a resource_output input requires resource_id and output_name.")
			return wire, diags
		}
		if valueJSON != "" || capsuleID != "" {
			diags.AddAttributeError(inputPath, "Invalid resource_output input", "a resource_output input takes resource_id, output_name, and optional pointer.")
			return wire, diags
		}
		wire.ResourceID = resourceID
		wire.OutputName = outputName
		wire.Pointer = pointer
	default:
		diags.AddAttributeError(inputPath, "Invalid input source", fmt.Sprintf("%q is not one of literal, capsule_output, resource_output.", source))
	}
	return wire, diags
}

func applyInterfaceRecord(record *client.InterfaceRecord, m *interfaceResourceModel) {
	m.ID = types.StringValue(record.Metadata.ID)
	m.WorkspaceID = types.StringValue(record.Metadata.WorkspaceID)
	m.CapsuleID = types.StringValue(record.Metadata.OwnerRef.ID)
	m.Phase = types.StringValue(record.Status.Phase)
	m.ResolvedRevision = types.Int64Value(record.Status.ResolvedRevision)
	// policy_ref is Optional+Computed: always track the server value so an
	// out-of-band Policy attach surfaces in state and a Computed value is never
	// left unknown after apply.
	m.PolicyRef = stringValueOrNull(record.Spec.Access.PolicyRef)
}

// interfaceETag derives the optimistic-concurrency tag the server expects in
// If-Match from the record itself (server contract: "if-{generation}-{resolvedRevision}").
// Deriving it locally instead of echoing the response ETag header immunizes the
// provider against proxies that weaken or rewrite the ETag.
func interfaceETag(record *client.InterfaceRecord) string {
	return fmt.Sprintf("\"if-%d-%d\"", record.Metadata.Generation, record.Status.ResolvedRevision)
}

// isRetryableInterfaceConflict reports whether err is a transient optimistic
// concurrency failure (412 failed_precondition or 409 conflict) worth retrying
// with a fresh read.
func isRetryableInterfaceConflict(err error) bool {
	var apiErr *client.APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusPreconditionFailed || apiErr.StatusCode == http.StatusConflict
	}
	return false
}

func errString(err error) string {
	if err == nil {
		return "unknown error"
	}
	return err.Error()
}

// refreshInterfaceState projects a freshly read record into state. The
// user-authored attributes (document_json, inputs, ...) are kept verbatim when
// they are semantically equal to the server record after canonical JSON
// re-marshalling, so formatting or key order never produces a spurious diff.
func refreshInterfaceState(ctx context.Context, record *client.InterfaceRecord, m *interfaceResourceModel) diag.Diagnostics {
	var diags diag.Diagnostics
	// Compare against the pre-refresh model first: applyInterfaceRecord mutates
	// the Computed policy_ref to the server value, which would otherwise mask a
	// genuine policy_ref drift in the match below.
	matches := interfaceStateMatchesRecord(ctx, m, record)
	applyInterfaceRecord(record, m)
	if matches {
		return diags
	}
	m.Name = types.StringValue(record.Metadata.Name)
	m.Type = types.StringValue(record.Spec.Type)
	m.Version = types.StringValue(record.Spec.Version)
	document, err := canonicalJSONString(record.Spec.Document)
	if err != nil {
		diags.AddError("Failed to refresh Interface", fmt.Sprintf("re-encoding spec.document: %s", err))
		return diags
	}
	m.DocumentJSON = types.StringValue(document)
	visibility := record.Spec.Access.Visibility
	if visibility == "" {
		visibility = interfaceDefaultVisibility
	}
	m.Visibility = types.StringValue(visibility)
	if record.Spec.Access.ResourceURIInput != "" {
		m.ResourceURIInput = types.StringValue(record.Spec.Access.ResourceURIInput)
	} else {
		m.ResourceURIInput = types.StringNull()
	}
	if len(record.Metadata.Labels) > 0 {
		labels, d := types.MapValueFrom(ctx, types.StringType, record.Metadata.Labels)
		diags.Append(d...)
		m.Labels = labels
	} else {
		m.Labels = types.MapNull(types.StringType)
	}
	inputs, d := interfaceInputsFromWire(record.Spec.Inputs)
	diags.Append(d...)
	m.Inputs = inputs
	return diags
}

func interfaceStateMatchesRecord(ctx context.Context, m *interfaceResourceModel, record *client.InterfaceRecord) bool {
	if m.Name.ValueString() != record.Metadata.Name {
		return false
	}
	stateLabels := map[string]string{}
	if !m.Labels.IsNull() && !m.Labels.IsUnknown() {
		if d := m.Labels.ElementsAs(ctx, &stateLabels, false); d.HasError() {
			return false
		}
	}
	if !stringMapsEqual(stateLabels, record.Metadata.Labels) {
		return false
	}
	// Use the model's own policy_ref (not the server's) so an out-of-band
	// Policy attach registers as drift and refreshes into state.
	spec, d := m.toSpec(ctx, record.Metadata.OwnerRef.ID, m.configuredPolicyRef())
	if d.HasError() || spec == nil {
		return false
	}
	stateRaw, err := canonicalJSONBytes(spec)
	if err != nil {
		return false
	}
	recordRaw, err := canonicalJSONBytes(record.Spec)
	if err != nil {
		return false
	}
	return bytes.Equal(stateRaw, recordRaw)
}

func interfaceInputsFromWire(inputs map[string]client.InterfaceInput) (types.Map, diag.Diagnostics) {
	var diags diag.Diagnostics
	objectType := types.ObjectType{AttrTypes: interfaceInputAttrTypes}
	if len(inputs) == 0 {
		return types.MapNull(objectType), diags
	}
	values := make(map[string]attr.Value, len(inputs))
	for name, input := range inputs {
		valueJSON := types.StringNull()
		if len(input.Value) > 0 {
			canonical, err := canonicalJSONString(input.Value)
			if err != nil {
				diags.AddError("Failed to refresh Interface", fmt.Sprintf("re-encoding inputs[%q].value: %s", name, err))
				return types.MapNull(objectType), diags
			}
			valueJSON = types.StringValue(canonical)
		}
		object, d := types.ObjectValue(interfaceInputAttrTypes, map[string]attr.Value{
			"source":      types.StringValue(input.Source),
			"output_name": stringValueOrNull(input.OutputName),
			"capsule_id":  stringValueOrNull(input.CapsuleID),
			"resource_id": stringValueOrNull(input.ResourceID),
			"pointer":     stringValueOrNull(input.Pointer),
			"value_json":  valueJSON,
		})
		diags.Append(d...)
		if diags.HasError() {
			return types.MapNull(objectType), diags
		}
		values[name] = object
	}
	result, d := types.MapValue(objectType, values)
	diags.Append(d...)
	return result, diags
}

func stringValueOrNull(v string) types.String {
	if v == "" {
		return types.StringNull()
	}
	return types.StringValue(v)
}

func stringMapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if other, ok := b[key]; !ok || other != value {
			return false
		}
	}
	return true
}

// canonicalJSONBytes re-marshals any JSON-marshalable value through a generic
// decode so formatting, key order, and json.RawMessage spacing normalize.
func canonicalJSONBytes(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	return json.Marshal(decoded)
}

func canonicalJSONString(v any) (string, error) {
	raw, err := canonicalJSONBytes(v)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
