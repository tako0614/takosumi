package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

// Allowed values for the frozen wire contract.
var (
	objectStoreInterfaces  = []string{"s3_api", "signed_url", "object_events"}
	lifecycleDeleteActions = []string{"delete", "retain", "snapshot_then_delete", "block"}
)

// lifecyclePolicyAttrTypes is the attr.Type map for the lifecycle_policy block.
var lifecyclePolicyAttrTypes = map[string]attr.Type{
	"delete": types.StringType,
}

// Ensure interface compliance.
var (
	_ resource.Resource                = (*objectStoreResource)(nil)
	_ resource.ResourceWithConfigure   = (*objectStoreResource)(nil)
	_ resource.ResourceWithImportState = (*objectStoreResource)(nil)
	_ resource.ResourceWithModifyPlan  = (*objectStoreResource)(nil)
)

// objectStoreResource implements the takosumi_object_store resource.
type objectStoreResource struct {
	data *providerData
}

// NewObjectStoreResource is the resource factory.
func NewObjectStoreResource() resource.Resource {
	return &objectStoreResource{}
}

// objectStoreModel maps the takosumi_object_store HCL schema.
type objectStoreModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Interfaces             types.Set    `tfsdk:"interfaces"`
	LifecyclePolicy        types.Object `tfsdk:"lifecycle_policy"`
	Space                  types.String `tfsdk:"space"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

// lifecyclePolicyModel maps the lifecycle_policy nested attribute.
type lifecyclePolicyModel struct {
	Delete types.String `tfsdk:"delete"`
}

func (r *objectStoreResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_object_store"
}

func (r *objectStoreResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A Takosumi ObjectStore resource shape. The desired interfaces and lifecycle " +
			"are declared here; the Takosumi Resolver selects the backend implementation and target.",
		Attributes: map[string]schema.Attribute{
			"name": schema.StringAttribute{
				Required:    true,
				Description: "ObjectStore name. Used as the resource key in the Takosumi API; changing it replaces the resource.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"interfaces": schema.SetAttribute{
				Required:    true,
				ElementType: types.StringType,
				Description: "Desired externally visible interfaces. Allowed values: " + strings.Join(objectStoreInterfaces, ", ") + ".",
				Validators: []validator.Set{
					SetStringsOneOf(1, objectStoreInterfaces...),
				},
			},
			"lifecycle_policy": schema.SingleNestedAttribute{
				Optional:    true,
				Description: "Optional lifecycle policy for the object store.",
				Attributes: map[string]schema.Attribute{
					"delete": schema.StringAttribute{
						Required:    true,
						Description: "Deletion behavior. Allowed values: " + strings.Join(lifecycleDeleteActions, ", ") + ".",
						Validators: []validator.String{
							StringOneOf(lifecycleDeleteActions...),
						},
					},
				},
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

			// Computed: the thin handle returned by the server.
			"id": schema.StringAttribute{
				Computed:    true,
				Description: "Takosumi resource identifier (tkrn:{space}:ObjectStore:{name} unless the server returns one).",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"selected_implementation": schema.StringAttribute{
				Computed:    true,
				Description: "Backend implementation selected by the Resolver (e.g. cloudflare_r2, aws_s3).",
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
				Description: "Resolved outputs (e.g. bucket name, endpoint).",
			},
		},
	}
}

func (r *objectStoreResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *objectStoreResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}

	var plan objectStoreModel
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

func (r *objectStoreResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}

	var state objectStoreModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	readSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	res, err := r.data.client.GetResource(ctx, client.KindObjectStore, state.Name.ValueString(), readSpace)
	if err != nil {
		if errors.Is(err, client.ErrNotFound) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Failed to read ObjectStore", err.Error())
		return
	}

	space := state.Space.ValueString()
	if res.Metadata.Space != "" {
		space = res.Metadata.Space
	}

	resp.Diagnostics.Append(refreshSpec(ctx, res, &state)...)
	resp.Diagnostics.Append(applyStatus(ctx, res, space, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *objectStoreResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}

	var plan objectStoreModel
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

func (r *objectStoreResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}

	var state objectStoreModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	deleteSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	if err := r.data.client.DeleteResource(ctx, client.KindObjectStore, state.Name.ValueString(), deleteSpace); err != nil {
		resp.Diagnostics.AddError("Failed to delete ObjectStore", err.Error())
	}
}

func (r *objectStoreResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	// Accept "name" or "space/name".
	if space, name, ok := strings.Cut(req.ID, "/"); ok {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("space"), space)...)
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), name)...)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), req.ID)...)
}

// ModifyPlan performs a best-effort plan-time preview for nicer diffs and early
// validation. Any transport error is tolerated by skipping silently.
func (r *objectStoreResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if r.data == nil || req.Plan.Raw.IsNull() {
		// Not configured, or this is a destroy plan: nothing to preview.
		return
	}

	var plan objectStoreModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Skip the preview if required values are not yet known.
	if plan.Name.IsUnknown() || plan.Interfaces.IsUnknown() {
		return
	}

	body, _, diags := plan.toResource(ctx, r.data.defaultSpace)
	if diags.HasError() {
		// A missing space is reported at apply time; do not fail the plan here.
		return
	}

	preview, err := r.data.client.PreviewResource(ctx, body)
	if err != nil || preview == nil || preview.Resource.Status == nil {
		return
	}

	for _, c := range preview.Resource.Status.Conditions {
		if strings.EqualFold(c.Type, "Blocked") && strings.EqualFold(c.Status, "true") {
			msg := c.Message
			if msg == "" {
				msg = "the Takosumi Resolver reports this resource as Blocked."
			}
			resp.Diagnostics.AddAttributeWarning(path.Root("name"), "Resolution may be blocked", msg)
		}
	}
}

// assertConfigured guards CRUD against an unconfigured provider.
func (r *objectStoreResource) assertConfigured(diags *diag.Diagnostics) bool {
	if r.data == nil || r.data.client == nil {
		diags.AddError(
			"Provider not configured",
			"The takosumi provider was not configured before use. This is usually a provider bug.",
		)
		return false
	}
	if !r.data.capabilities.SupportsResource(client.KindObjectStore) {
		diags.AddError(
			"ObjectStore not supported",
			"The configured Takosumi endpoint does not advertise the ObjectStore resource shape.",
		)
		return false
	}
	return true
}

// put builds the Resource envelope from plan, PUTs it, and maps the response
// status back onto plan. Used by both Create and Update.
func (r *objectStoreResource) put(ctx context.Context, plan *objectStoreModel, diags *diag.Diagnostics) {
	body, space, d := plan.toResource(ctx, r.data.defaultSpace)
	diags.Append(d...)
	if diags.HasError() {
		return
	}

	res, err := r.data.client.PutResource(ctx, client.KindObjectStore, plan.Name.ValueString(), body)
	if err != nil {
		diags.AddError("Failed to apply ObjectStore", err.Error())
		return
	}

	plan.Space = types.StringValue(space)
	diags.Append(applyStatus(ctx, res, space, plan)...)
}

// toResource builds the request-side Resource envelope from the model and
// resolves the effective space (resource override or provider default).
func (m objectStoreModel) toResource(ctx context.Context, defaultSpace string) (*client.Resource, string, diag.Diagnostics) {
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

	var interfaces []string
	diags.Append(m.Interfaces.ElementsAs(ctx, &interfaces, false)...)
	if diags.HasError() {
		return nil, "", diags
	}

	spec := map[string]any{
		"name":       name,
		"interfaces": interfaces,
	}

	if !m.LifecyclePolicy.IsNull() && !m.LifecyclePolicy.IsUnknown() {
		var lp lifecyclePolicyModel
		diags.Append(m.LifecyclePolicy.As(ctx, &lp, basetypes.ObjectAsOptions{})...)
		if diags.HasError() {
			return nil, "", diags
		}
		if del := lp.Delete.ValueString(); del != "" {
			spec["lifecyclePolicy"] = map[string]any{"delete": del}
		}
	}

	res := &client.Resource{
		APIVersion: client.APIVersion,
		Kind:       client.KindObjectStore,
		Metadata: client.Metadata{
			Name:      name,
			Space:     space,
			ManagedBy: client.ManagedByOpenTofu,
		},
		Spec: spec,
	}
	return res, space, diags
}

// applyStatus maps a server Resource response onto the model's computed
// attributes (id + resolution + outputs).
func applyStatus(ctx context.Context, res *client.Resource, space string, m *objectStoreModel) diag.Diagnostics {
	var diags diag.Diagnostics

	m.ID = types.StringValue(resourceID(res, space, m.Name.ValueString()))

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

// refreshSpec reconciles the model's configured attributes from a server
// Resource response (used by Read to detect drift).
func refreshSpec(ctx context.Context, res *client.Resource, m *objectStoreModel) diag.Diagnostics {
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

	if raw, ok := res.Spec["interfaces"]; ok {
		set, d := types.SetValueFrom(ctx, types.StringType, toStringSlice(raw))
		diags.Append(d...)
		m.Interfaces = set
	}

	if raw, ok := res.Spec["lifecyclePolicy"]; ok {
		if obj, isMap := raw.(map[string]any); isMap {
			del, _ := obj["delete"].(string)
			lp, d := types.ObjectValue(lifecyclePolicyAttrTypes, map[string]attr.Value{
				"delete": types.StringValue(del),
			})
			diags.Append(d...)
			m.LifecyclePolicy = lp
		}
	} else {
		m.LifecyclePolicy = types.ObjectNull(lifecyclePolicyAttrTypes)
	}

	return diags
}

// resourceID returns the server-provided id when present, otherwise synthesizes
// tkrn:{space}:ObjectStore:{name}.
func resourceID(res *client.Resource, space, name string) string {
	return resourceIDForKind(res, space, client.KindObjectStore, name)
}

func resourceIDForKind(res *client.Resource, space, kind, name string) string {
	if res.ID != "" {
		return res.ID
	}
	if res.Metadata.ID != "" {
		return res.Metadata.ID
	}
	return fmt.Sprintf("tkrn:%s:%s:%s", space, kind, name)
}

func effectiveSpace(value types.String, fallback string) string {
	if value.IsNull() || value.IsUnknown() || value.ValueString() == "" {
		return fallback
	}
	return value.ValueString()
}

func outputsToStringMap(outputs map[string]any) map[string]string {
	if len(outputs) == 0 {
		return map[string]string{}
	}
	out := make(map[string]string, len(outputs))
	for key, value := range outputs {
		switch v := value.(type) {
		case string:
			out[key] = v
		case nil:
			out[key] = ""
		default:
			if raw, err := json.Marshal(v); err == nil {
				out[key] = string(raw)
			} else {
				out[key] = fmt.Sprint(v)
			}
		}
	}
	return out
}

// toStringSlice coerces a decoded JSON value (typically []any) into []string.
func toStringSlice(raw any) []string {
	switch v := raw.(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}
