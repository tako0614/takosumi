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

var httpServiceRuntimeInterfaces = []string{"web_fetch", "node_http", "container_http"}

var (
	_ resource.Resource                = (*httpServiceResource)(nil)
	_ resource.ResourceWithConfigure   = (*httpServiceResource)(nil)
	_ resource.ResourceWithImportState = (*httpServiceResource)(nil)
	_ resource.ResourceWithModifyPlan  = (*httpServiceResource)(nil)
)

type httpServiceResource struct {
	data *providerData
}

func NewHttpServiceResource() resource.Resource {
	return &httpServiceResource{}
}

type httpServiceModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	RuntimeInterface       types.String `tfsdk:"runtime_interface"`
	ArtifactPath           types.String `tfsdk:"artifact_path"`
	PublicHTTP             types.Bool   `tfsdk:"public_http"`
	Space                  types.String `tfsdk:"space"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

func (r *httpServiceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_http_service"
}

func (r *httpServiceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A Takosumi HttpService resource shape. The Takosumi Resolver selects the backend implementation and target.",
		Attributes: map[string]schema.Attribute{
			"name": schema.StringAttribute{
				Required:    true,
				Description: "HttpService name. Changing it replaces the resource.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"runtime_interface": schema.StringAttribute{
				Required:    true,
				Description: "Desired runtime interface. Allowed values: web_fetch, node_http, container_http.",
				Validators: []validator.String{
					StringOneOf(httpServiceRuntimeInterfaces...),
				},
			},
			"artifact_path": schema.StringAttribute{
				Optional:    true,
				Description: "OpenTofu-runner-local path to a prebuilt artifact. Takosumi does not build or fetch it implicitly.",
			},
			"public_http": schema.BoolAttribute{
				Optional:    true,
				Description: "Whether the service should be exposed over public HTTP.",
			},
			"space": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Space for this resource. Overrides the provider default; changing it replaces the resource.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
					stringplanmodifier.UseStateForUnknown(),
				},
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

func (r *httpServiceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *httpServiceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan httpServiceModel
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

func (r *httpServiceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state httpServiceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	readSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	res, err := r.data.client.GetResource(ctx, client.KindHttpService, state.Name.ValueString(), readSpace)
	if err != nil {
		if errors.Is(err, client.ErrNotFound) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Failed to read HttpService", err.Error())
		return
	}
	space := state.Space.ValueString()
	if res.Metadata.Space != "" {
		space = res.Metadata.Space
	}
	resp.Diagnostics.Append(refreshHttpServiceSpec(res, &state)...)
	resp.Diagnostics.Append(applyHttpServiceStatus(ctx, res, space, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *httpServiceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan httpServiceModel
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

func (r *httpServiceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state httpServiceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	deleteSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	if err := r.data.client.DeleteResource(ctx, client.KindHttpService, state.Name.ValueString(), deleteSpace); err != nil {
		resp.Diagnostics.AddError("Failed to delete HttpService", err.Error())
	}
}

func (r *httpServiceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if space, name, ok := cutSpaceName(req.ID); ok {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("space"), space)...)
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), name)...)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), req.ID)...)
}

func (r *httpServiceResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, _ *resource.ModifyPlanResponse) {
	if r.data == nil || req.Plan.Raw.IsNull() {
		return
	}
	var plan httpServiceModel
	_ = req.Plan.Get(ctx, &plan)
	if plan.Name.IsUnknown() || plan.RuntimeInterface.IsUnknown() {
		return
	}
	body, _, diags := plan.toResource(r.data.defaultSpace)
	if diags.HasError() {
		return
	}
	_, _ = r.data.client.PreviewResource(ctx, body)
}

func (r *httpServiceResource) assertConfigured(diags *diag.Diagnostics) bool {
	if r.data == nil || r.data.client == nil {
		diags.AddError(
			"Provider not configured",
			"The takosumi provider was not configured before use. This is usually a provider bug.",
		)
		return false
	}
	if !r.data.capabilities.SupportsResource(client.KindHttpService) {
		diags.AddError(
			"HttpService not supported",
			"The configured Takosumi endpoint does not advertise the HttpService resource shape.",
		)
		return false
	}
	return true
}

func (r *httpServiceResource) put(ctx context.Context, plan *httpServiceModel, diags *diag.Diagnostics) {
	body, space, d := plan.toResource(r.data.defaultSpace)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	res, err := r.data.client.PutResource(ctx, client.KindHttpService, plan.Name.ValueString(), body)
	if err != nil {
		diags.AddError("Failed to apply HttpService", err.Error())
		return
	}
	plan.Space = types.StringValue(space)
	diags.Append(applyHttpServiceStatus(ctx, res, space, plan)...)
}

func (m httpServiceModel) toResource(defaultSpace string) (*client.Resource, string, diag.Diagnostics) {
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
	runtime := map[string]any{
		"interface": m.RuntimeInterface.ValueString(),
	}
	if !m.ArtifactPath.IsNull() && !m.ArtifactPath.IsUnknown() && m.ArtifactPath.ValueString() != "" {
		runtime["source"] = map[string]any{"artifactPath": m.ArtifactPath.ValueString()}
	}
	spec := map[string]any{
		"name":    name,
		"runtime": runtime,
	}
	if !m.PublicHTTP.IsNull() && !m.PublicHTTP.IsUnknown() {
		spec["exposure"] = map[string]any{"publicHttp": m.PublicHTTP.ValueBool()}
	}
	return &client.Resource{
		APIVersion: client.APIVersion,
		Kind:       client.KindHttpService,
		Metadata: client.Metadata{
			Name:      name,
			Space:     space,
			ManagedBy: client.ManagedByOpenTofu,
		},
		Spec: spec,
	}, space, diags
}

func applyHttpServiceStatus(ctx context.Context, res *client.Resource, space string, m *httpServiceModel) diag.Diagnostics {
	var diags diag.Diagnostics
	m.ID = types.StringValue(resourceIDForKind(res, space, client.KindHttpService, m.Name.ValueString()))
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

func refreshHttpServiceSpec(res *client.Resource, m *httpServiceModel) diag.Diagnostics {
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
	if raw, ok := res.Spec["runtime"].(map[string]any); ok {
		if iface, ok := raw["interface"].(string); ok {
			m.RuntimeInterface = types.StringValue(iface)
		}
		if source, ok := raw["source"].(map[string]any); ok {
			if artifactPath, ok := source["artifactPath"].(string); ok {
				m.ArtifactPath = types.StringValue(artifactPath)
			} else {
				m.ArtifactPath = types.StringNull()
			}
		} else {
			m.ArtifactPath = types.StringNull()
		}
	}
	if raw, ok := res.Spec["exposure"].(map[string]any); ok {
		if publicHTTP, ok := raw["publicHttp"].(bool); ok {
			m.PublicHTTP = types.BoolValue(publicHTTP)
		} else {
			m.PublicHTTP = types.BoolNull()
		}
	} else {
		m.PublicHTTP = types.BoolNull()
	}
	return diags
}

func cutSpaceName(id string) (string, string, bool) {
	for i, r := range id {
		if r == '/' {
			return id[:i], id[i+1:], true
		}
	}
	return "", "", false
}
