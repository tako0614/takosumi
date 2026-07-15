package provider

import (
	"context"
	"errors"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

var (
	_ resource.Resource                = (*edgeWorkerResource)(nil)
	_ resource.ResourceWithConfigure   = (*edgeWorkerResource)(nil)
	_ resource.ResourceWithImportState = (*edgeWorkerResource)(nil)
)

type edgeWorkerResource struct {
	data *providerData
}

func NewEdgeWorkerResource() resource.Resource {
	return &edgeWorkerResource{}
}

type edgeWorkerModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	ArtifactPath           types.String `tfsdk:"artifact_path"`
	ArtifactURL            types.String `tfsdk:"artifact_url"`
	ArtifactRef            types.String `tfsdk:"artifact_ref"`
	ArtifactSHA256         types.String `tfsdk:"artifact_sha256"`
	CompatibilityDate      types.String `tfsdk:"compatibility_date"`
	CompatibilityFlags     types.Set    `tfsdk:"compatibility_flags"`
	Profiles               types.Set    `tfsdk:"profiles"`
	Connections            types.List   `tfsdk:"connections"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

func (r *edgeWorkerResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_edge_worker"
}

func (r *edgeWorkerResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A Takosumi EdgeWorker resource shape. The Takosumi Resolver selects the backend implementation and target.",
		Attributes: map[string]schema.Attribute{
			"name": schema.StringAttribute{
				Required:    true,
				Description: "EdgeWorker name. Changing it replaces the resource.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"artifact_path": schema.StringAttribute{
				Optional:    true,
				Description: "OpenTofu-runner-local path to a prebuilt Worker artifact. Mutually exclusive with artifact_url.",
			},
			"artifact_url": schema.StringAttribute{
				Optional:    true,
				Description: "HTTPS URL to a CI/release-produced Worker artifact fetched by the generated OpenTofu module. Requires artifact_sha256.",
			},
			"artifact_ref": schema.StringAttribute{
				Optional:    true,
				Description: "Host-allocated opaque immutable Worker artifact reference. Requires artifact_sha256.",
			},
			"artifact_sha256": schema.StringAttribute{
				Optional:    true,
				Description: "Expected Worker artifact SHA-256 hex digest, optionally prefixed with sha256:. Required with artifact_url.",
			},
			"compatibility_date": schema.StringAttribute{
				Optional:    true,
				Description: "Optional Worker runtime compatibility date.",
			},
			"compatibility_flags": schema.SetAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Optional Worker runtime compatibility flags. Values are endpoint-defined tokens.",
				Validators: []validator.Set{
					SetStringsNonEmpty(0),
				},
			},
			"profiles": schema.SetAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Optional Worker profile tokens. Values are endpoint-defined and validated by Takosumi capabilities, TargetPool policy, and the Resolver.",
				Validators: []validator.Set{
					SetStringsNonEmpty(0),
				},
			},
			"connections": resourceConnectionAttribute(),
			"space": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Space for this resource. Overrides the provider default; changing it replaces the resource.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"target_pool": schema.StringAttribute{
				Optional:    true,
				Description: "Optional TargetPool name. Defaults to the server-side default TargetPool for the Space.",
				Validators:  []validator.String{StringToken()},
			},
			"id": schema.StringAttribute{
				Computed:    true,
				Description: "Takosumi resource identifier.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"selected_implementation": schema.StringAttribute{
				Computed:    true,
				Description: "Backend implementation selected by the Resolver.",
			},
			"target": schema.StringAttribute{
				Computed:    true,
				Description: "Target the resource landed on.",
			},
			"locked": schema.BoolAttribute{
				Computed:    true,
				Description: "Whether the resolution is locked.",
			},
			"portability": schema.StringAttribute{
				Computed:    true,
				Description: "Resolver portability assessment.",
			},
			"outputs": schema.MapAttribute{
				Computed:    true,
				ElementType: types.StringType,
				Description: "Resolved outputs.",
			},
		},
	}
}

func (r *edgeWorkerResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *edgeWorkerResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan edgeWorkerModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *edgeWorkerResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state edgeWorkerModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	readSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	res, err := r.data.client.ObserveResource(ctx, client.KindEdgeWorker, state.Name.ValueString(), readSpace)
	if err != nil {
		if errors.Is(err, client.ErrNotFound) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Failed to read EdgeWorker", err.Error())
		return
	}
	space := state.Space.ValueString()
	if res.Metadata.Space != "" {
		space = res.Metadata.Space
	}
	resp.Diagnostics.Append(refreshEdgeWorkerSpec(res, &state)...)
	resp.Diagnostics.Append(applyEdgeWorkerStatus(ctx, res, space, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *edgeWorkerResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan edgeWorkerModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *edgeWorkerResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state edgeWorkerModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	deleteSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	r.data.resourceShapeMutate.Lock()
	defer r.data.resourceShapeMutate.Unlock()
	if err := r.data.client.DeleteResource(ctx, client.KindEdgeWorker, state.Name.ValueString(), deleteSpace); err != nil {
		resp.Diagnostics.AddError("Failed to delete EdgeWorker", err.Error())
	}
}

func (r *edgeWorkerResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if space, name, ok := cutSpaceName(req.ID); ok {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("space"), space)...)
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), name)...)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), req.ID)...)
}

func (r *edgeWorkerResource) assertConfigured(diags *diag.Diagnostics) bool {
	if r.data == nil || r.data.client == nil {
		diags.AddError(
			"Provider not configured",
			"The takosumi provider was not configured before use. This is usually a provider bug.",
		)
		return false
	}
	if !r.data.capabilities.SupportsResource(client.KindEdgeWorker) {
		diags.AddError(
			"EdgeWorker not supported",
			"The configured Takosumi endpoint does not advertise the EdgeWorker resource shape.",
		)
		return false
	}
	return true
}

func (r *edgeWorkerResource) put(ctx context.Context, plan *edgeWorkerModel, diags *diag.Diagnostics) {
	body, space, d := plan.toResource(ctx, r.data.defaultSpace)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	r.data.resourceShapeMutate.Lock()
	defer r.data.resourceShapeMutate.Unlock()
	res, err := r.data.client.PutResource(ctx, client.KindEdgeWorker, plan.Name.ValueString(), body)
	if err != nil {
		diags.AddError("Failed to apply EdgeWorker", err.Error())
		return
	}
	plan.Space = types.StringValue(space)
	diags.Append(applyEdgeWorkerStatus(ctx, res, space, plan)...)
}

func (m edgeWorkerModel) toResource(ctx context.Context, defaultSpace string) (*client.Resource, string, diag.Diagnostics) {
	var diags diag.Diagnostics
	space := m.Space.ValueString()
	if m.Space.IsNull() || m.Space.IsUnknown() || space == "" {
		space = defaultSpace
	}
	if space == "" {
		diags.AddAttributeError(
			path.Root("space"),
			"Missing space",
			"A Space is required. Set the resource `space` attribute or the provider `space`/TAKOSUMI_SPACE default.",
		)
		return nil, "", diags
	}
	name := m.Name.ValueString()
	source, sourceDiags := (artifactSourceValues{
		Path: m.ArtifactPath, URL: m.ArtifactURL,
		Ref: m.ArtifactRef, SHA256: m.ArtifactSHA256,
	}).toSpec("EdgeWorker")
	diags.Append(sourceDiags...)
	if diags.HasError() {
		return nil, "", diags
	}
	spec := map[string]any{
		"name":   name,
		"source": source,
	}
	if !m.CompatibilityDate.IsNull() && !m.CompatibilityDate.IsUnknown() && m.CompatibilityDate.ValueString() != "" {
		spec["compatibilityDate"] = m.CompatibilityDate.ValueString()
	}
	if !m.CompatibilityFlags.IsNull() && !m.CompatibilityFlags.IsUnknown() {
		var flags []string
		diags.Append(m.CompatibilityFlags.ElementsAs(ctx, &flags, false)...)
		if diags.HasError() {
			return nil, "", diags
		}
		if len(flags) > 0 {
			spec["compatibilityFlags"] = flags
		}
	}
	if !m.Profiles.IsNull() && !m.Profiles.IsUnknown() {
		var profiles []string
		diags.Append(m.Profiles.ElementsAs(ctx, &profiles, false)...)
		if diags.HasError() {
			return nil, "", diags
		}
		if len(profiles) > 0 {
			spec["profiles"] = profiles
		}
	}
	if connections := resourceConnectionsToSpec(ctx, m.Connections, &diags); len(connections) > 0 {
		spec["connections"] = connections
	}
	targetPool := ""
	if !m.TargetPool.IsNull() && !m.TargetPool.IsUnknown() {
		targetPool = m.TargetPool.ValueString()
	}
	return &client.Resource{
		APIVersion: client.APIVersion,
		Kind:       client.KindEdgeWorker,
		Metadata: client.Metadata{
			Name:      name,
			Space:     space,
			ManagedBy: client.ManagedByOpenTofu,
		},
		Spec:           spec,
		TargetPoolName: targetPool,
	}, space, diags
}

func applyEdgeWorkerStatus(ctx context.Context, res *client.Resource, space string, m *edgeWorkerModel) diag.Diagnostics {
	var diags diag.Diagnostics
	m.ID = types.StringValue(resourceIDForKind(res, space, client.KindEdgeWorker, m.Name.ValueString()))
	if res.Status != nil {
		m.SelectedImplementation = types.StringValue(res.Status.Resolution.SelectedImplementation)
		m.Target = types.StringValue(res.Status.Resolution.Target)
		m.Locked = types.BoolValue(res.Status.Resolution.Locked)
		m.Portability = types.StringValue(res.Status.Resolution.Portability)
		outputs, d := types.MapValueFrom(ctx, types.StringType, outputsToStringMap(res.Status.Outputs))
		diags.Append(d...)
		m.Outputs = outputs
	} else {
		m.SelectedImplementation = types.StringValue("")
		m.Target = types.StringValue("")
		m.Locked = types.BoolValue(false)
		m.Portability = types.StringValue("")
		m.Outputs = types.MapValueMust(types.StringType, map[string]attr.Value{})
	}
	return diags
}

func refreshEdgeWorkerSpec(res *client.Resource, m *edgeWorkerModel) diag.Diagnostics {
	var diags diag.Diagnostics
	if res.Metadata.Name != "" {
		m.Name = types.StringValue(res.Metadata.Name)
	}
	if res.Metadata.Space != "" {
		m.Space = types.StringValue(res.Metadata.Space)
	}
	if res.Spec == nil {
		return diags
	}
	source := artifactSourceValuesFromSpec(res.Spec["source"])
	m.ArtifactPath = source.Path
	m.ArtifactURL = source.URL
	m.ArtifactRef = source.Ref
	m.ArtifactSHA256 = source.SHA256
	if compatibilityDate, ok := res.Spec["compatibilityDate"].(string); ok {
		m.CompatibilityDate = types.StringValue(compatibilityDate)
	} else {
		m.CompatibilityDate = types.StringNull()
	}
	if raw, ok := res.Spec["compatibilityFlags"].([]any); ok {
		m.CompatibilityFlags = stringSetFromAny(raw)
	} else {
		m.CompatibilityFlags = types.SetNull(types.StringType)
	}
	if raw, ok := res.Spec["profiles"].([]any); ok {
		m.Profiles = stringSetFromAny(raw)
	} else {
		m.Profiles = types.SetNull(types.StringType)
	}
	if raw, ok := res.Spec["connections"]; ok {
		connections, d := resourceConnectionsFromSpec(context.Background(), raw)
		diags.Append(d...)
		m.Connections = connections
	} else {
		m.Connections = types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes})
	}
	return diags
}

func stringSetFromAny(raw []any) types.Set {
	values := make([]attr.Value, 0, len(raw))
	for _, item := range raw {
		if value, ok := item.(string); ok {
			values = append(values, types.StringValue(value))
		}
	}
	return types.SetValueMust(types.StringType, values)
}

func cutSpaceName(id string) (string, string, bool) {
	for i, r := range id {
		if r == '/' {
			return id[:i], id[i+1:], true
		}
	}
	return "", "", false
}
