package provider

import (
	"context"
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

var (
	knownAIEndpointInterfaces = []string{
		"openai_chat_completions",
		"openai_responses",
		"openai_embeddings",
	}
	knownAIEndpointProfiles = []string{
		"openai_compatible",
		"workers_ai",
		"anthropic_messages",
		"gemini_compat",
	}
	aiEndpointModelPolicyAttrTypes = map[string]attr.Type{
		"default_model":  types.StringType,
		"allowed_models": types.SetType{ElemType: types.StringType},
	}
	aiEndpointRoutingPolicyAttrTypes = map[string]attr.Type{
		"strategy":          types.StringType,
		"allow_fallback":    types.BoolType,
		"preferred_regions": types.SetType{ElemType: types.StringType},
	}
)

var (
	_ resource.Resource                = (*aiEndpointResource)(nil)
	_ resource.ResourceWithConfigure   = (*aiEndpointResource)(nil)
	_ resource.ResourceWithImportState = (*aiEndpointResource)(nil)
	_ resource.ResourceWithModifyPlan  = (*aiEndpointResource)(nil)
)

type aiEndpointResource struct {
	data *providerData
}

func NewAIEndpointResource() resource.Resource {
	return &aiEndpointResource{}
}

type aiEndpointModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Interfaces             types.Set    `tfsdk:"interfaces"`
	Profiles               types.Set    `tfsdk:"profiles"`
	ProviderPreferences    types.Set    `tfsdk:"provider_preferences"`
	RoutingPolicy          types.Object `tfsdk:"routing_policy"`
	ModelPolicy            types.Object `tfsdk:"model_policy"`
	Space                  types.String `tfsdk:"space"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type aiEndpointModelPolicyModel struct {
	DefaultModel  types.String `tfsdk:"default_model"`
	AllowedModels types.Set    `tfsdk:"allowed_models"`
}

type aiEndpointRoutingPolicyModel struct {
	Strategy         types.String `tfsdk:"strategy"`
	AllowFallback    types.Bool   `tfsdk:"allow_fallback"`
	PreferredRegions types.Set    `tfsdk:"preferred_regions"`
}

func (r *aiEndpointResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_ai_endpoint"
}

func (r *aiEndpointResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A Takosumi AIEndpoint resource shape. The HCL declares the AI API surface and model policy; the Takosumi Resolver and operator capabilities select the actual AI provider, gateway, and target.",
		Attributes: map[string]schema.Attribute{
			"name": schema.StringAttribute{
				Required:    true,
				Description: "AIEndpoint name. Changing it replaces the resource.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"interfaces": schema.SetAttribute{
				Required:    true,
				ElementType: types.StringType,
				Description: "Desired AI API interface tokens. Known values include: " + strings.Join(knownAIEndpointInterfaces, ", ") + ". Additional tokens may be accepted by the configured Takosumi endpoint.",
				Validators: []validator.Set{
					SetStringsNonEmpty(1),
				},
			},
			"profiles": schema.SetAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Optional compatibility profile tokens. Known values include: " + strings.Join(knownAIEndpointProfiles, ", ") + ". Endpoint capabilities, TargetPool, policy, and the resolver decide which profiles are supported.",
				Validators: []validator.Set{
					SetStringsNonEmpty(0),
				},
			},
			"provider_preferences": schema.SetAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Optional provider/capability preference tokens such as provider.deepseek, provider.gemini, provider.bedrock, or provider.vertex. They are preferences only: the Takosumi endpoint, resolver, TargetPool, and operator policy decide support and final routing.",
				Validators: []validator.Set{
					SetStringsNonEmpty(0),
				},
			},
			"routing_policy": schema.SingleNestedAttribute{
				Optional:    true,
				Description: "Optional routing preferences. These values do not force a vendor; they are interpreted by the configured Takosumi endpoint and operator policy.",
				Attributes: map[string]schema.Attribute{
					"strategy": schema.StringAttribute{
						Optional:    true,
						Description: "Extensible routing strategy token, for example operator_default, fixed, fallback, lowest_cost, lowest_latency, or highest_quality.",
						Validators: []validator.String{
							StringToken(),
						},
					},
					"allow_fallback": schema.BoolAttribute{
						Optional:    true,
						Description: "Whether another eligible AI provider may be used when the preferred route is unavailable and policy permits fallback.",
					},
					"preferred_regions": schema.SetAttribute{
						Optional:    true,
						ElementType: types.StringType,
						Description: "Optional serving/data region preference tokens. Operator policy decides whether they are meaningful for the selected provider.",
						Validators: []validator.Set{
							SetStringsNonEmpty(0),
						},
					},
				},
			},
			"model_policy": schema.SingleNestedAttribute{
				Optional:    true,
				Description: "Optional public model alias policy. Upstream API keys are ProviderConnection/Credential material and must not be stored here.",
				Attributes: map[string]schema.Attribute{
					"default_model": schema.StringAttribute{
						Optional:    true,
						Description: "Default public model alias.",
					},
					"allowed_models": schema.SetAttribute{
						Optional:    true,
						ElementType: types.StringType,
						Description: "Allowed public model aliases.",
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

func (r *aiEndpointResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *aiEndpointResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan aiEndpointModel
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

func (r *aiEndpointResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state aiEndpointModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	readSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	res, err := r.data.client.GetResource(ctx, client.KindAIEndpoint, state.Name.ValueString(), readSpace)
	if err != nil {
		if errors.Is(err, client.ErrNotFound) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Failed to read AIEndpoint", err.Error())
		return
	}
	space := state.Space.ValueString()
	if res.Metadata.Space != "" {
		space = res.Metadata.Space
	}
	resp.Diagnostics.Append(refreshAIEndpointSpec(ctx, res, &state)...)
	resp.Diagnostics.Append(applyAIEndpointStatus(ctx, res, space, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *aiEndpointResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan aiEndpointModel
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

func (r *aiEndpointResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state aiEndpointModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	deleteSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	if err := r.data.client.DeleteResource(ctx, client.KindAIEndpoint, state.Name.ValueString(), deleteSpace); err != nil {
		resp.Diagnostics.AddError("Failed to delete AIEndpoint", err.Error())
	}
}

func (r *aiEndpointResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if space, name, ok := cutSpaceName(req.ID); ok {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("space"), space)...)
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), name)...)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), req.ID)...)
}

func (r *aiEndpointResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, _ *resource.ModifyPlanResponse) {
	if r.data == nil || req.Plan.Raw.IsNull() {
		return
	}
	var plan aiEndpointModel
	_ = req.Plan.Get(ctx, &plan)
	if plan.Name.IsUnknown() || plan.Interfaces.IsUnknown() {
		return
	}
	body, _, diags := plan.toResource(ctx, r.data.defaultSpace)
	if diags.HasError() {
		return
	}
	_, _ = r.data.client.PreviewResource(ctx, body)
}

func (r *aiEndpointResource) assertConfigured(diags *diag.Diagnostics) bool {
	if r.data == nil || r.data.client == nil {
		diags.AddError(
			"Provider not configured",
			"The takosumi provider was not configured before use. This is usually a provider bug.",
		)
		return false
	}
	if !r.data.capabilities.SupportsResource(client.KindAIEndpoint) {
		diags.AddError(
			"AIEndpoint not supported",
			"The configured Takosumi endpoint does not advertise the AIEndpoint resource shape.",
		)
		return false
	}
	return true
}

func (r *aiEndpointResource) put(ctx context.Context, plan *aiEndpointModel, diags *diag.Diagnostics) {
	body, space, d := plan.toResource(ctx, r.data.defaultSpace)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	res, err := r.data.client.PutResource(ctx, client.KindAIEndpoint, plan.Name.ValueString(), body)
	if err != nil {
		diags.AddError("Failed to apply AIEndpoint", err.Error())
		return
	}
	plan.Space = types.StringValue(space)
	diags.Append(applyAIEndpointStatus(ctx, res, space, plan)...)
}

func (m aiEndpointModel) toResource(ctx context.Context, defaultSpace string) (*client.Resource, string, diag.Diagnostics) {
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
	if !m.Profiles.IsNull() && !m.Profiles.IsUnknown() {
		var profiles []string
		diags.Append(m.Profiles.ElementsAs(ctx, &profiles, false)...)
		if diags.HasError() {
			return nil, "", diags
		}
		spec["profiles"] = profiles
	}
	if !m.ProviderPreferences.IsNull() && !m.ProviderPreferences.IsUnknown() {
		var preferences []string
		diags.Append(m.ProviderPreferences.ElementsAs(ctx, &preferences, false)...)
		if diags.HasError() {
			return nil, "", diags
		}
		spec["providerPreferences"] = preferences
	}
	if !m.RoutingPolicy.IsNull() && !m.RoutingPolicy.IsUnknown() {
		var policy aiEndpointRoutingPolicyModel
		diags.Append(m.RoutingPolicy.As(ctx, &policy, basetypes.ObjectAsOptions{})...)
		if diags.HasError() {
			return nil, "", diags
		}
		routingPolicy := map[string]any{}
		if !policy.Strategy.IsNull() && !policy.Strategy.IsUnknown() && policy.Strategy.ValueString() != "" {
			routingPolicy["strategy"] = policy.Strategy.ValueString()
		}
		if !policy.AllowFallback.IsNull() && !policy.AllowFallback.IsUnknown() {
			routingPolicy["allowFallback"] = policy.AllowFallback.ValueBool()
		}
		if !policy.PreferredRegions.IsNull() && !policy.PreferredRegions.IsUnknown() {
			var regions []string
			diags.Append(policy.PreferredRegions.ElementsAs(ctx, &regions, false)...)
			if diags.HasError() {
				return nil, "", diags
			}
			routingPolicy["preferredRegions"] = regions
		}
		if len(routingPolicy) > 0 {
			spec["routingPolicy"] = routingPolicy
		}
	}
	if !m.ModelPolicy.IsNull() && !m.ModelPolicy.IsUnknown() {
		var policy aiEndpointModelPolicyModel
		diags.Append(m.ModelPolicy.As(ctx, &policy, basetypes.ObjectAsOptions{})...)
		if diags.HasError() {
			return nil, "", diags
		}
		modelPolicy := map[string]any{}
		if !policy.DefaultModel.IsNull() && !policy.DefaultModel.IsUnknown() && policy.DefaultModel.ValueString() != "" {
			modelPolicy["defaultModel"] = policy.DefaultModel.ValueString()
		}
		if !policy.AllowedModels.IsNull() && !policy.AllowedModels.IsUnknown() {
			var allowed []string
			diags.Append(policy.AllowedModels.ElementsAs(ctx, &allowed, false)...)
			if diags.HasError() {
				return nil, "", diags
			}
			modelPolicy["allowedModels"] = allowed
		}
		if len(modelPolicy) > 0 {
			spec["modelPolicy"] = modelPolicy
		}
	}

	return &client.Resource{
		APIVersion: client.APIVersion,
		Kind:       client.KindAIEndpoint,
		Metadata: client.Metadata{
			Name:      name,
			Space:     space,
			ManagedBy: client.ManagedByOpenTofu,
		},
		Spec: spec,
	}, space, diags
}

func applyAIEndpointStatus(ctx context.Context, res *client.Resource, space string, m *aiEndpointModel) diag.Diagnostics {
	var diags diag.Diagnostics
	m.ID = types.StringValue(resourceIDForKind(res, space, client.KindAIEndpoint, m.Name.ValueString()))
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

func refreshAIEndpointSpec(ctx context.Context, res *client.Resource, m *aiEndpointModel) diag.Diagnostics {
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
	if raw, ok := res.Spec["profiles"]; ok {
		set, d := types.SetValueFrom(ctx, types.StringType, toStringSlice(raw))
		diags.Append(d...)
		m.Profiles = set
	} else {
		m.Profiles = types.SetNull(types.StringType)
	}
	if raw, ok := res.Spec["providerPreferences"]; ok {
		set, d := types.SetValueFrom(ctx, types.StringType, toStringSlice(raw))
		diags.Append(d...)
		m.ProviderPreferences = set
	} else {
		m.ProviderPreferences = types.SetNull(types.StringType)
	}
	if raw, ok := res.Spec["routingPolicy"].(map[string]any); ok {
		strategy, _ := raw["strategy"].(string)
		allowFallback, hasAllowFallback := raw["allowFallback"].(bool)
		regions, d := types.SetValueFrom(ctx, types.StringType, toStringSlice(raw["preferredRegions"]))
		diags.Append(d...)
		allowFallbackValue := types.BoolNull()
		if hasAllowFallback {
			allowFallbackValue = types.BoolValue(allowFallback)
		}
		strategyValue := types.StringNull()
		if strategy != "" {
			strategyValue = types.StringValue(strategy)
		}
		obj, d := types.ObjectValue(aiEndpointRoutingPolicyAttrTypes, map[string]attr.Value{
			"strategy":          strategyValue,
			"allow_fallback":    allowFallbackValue,
			"preferred_regions": regions,
		})
		diags.Append(d...)
		m.RoutingPolicy = obj
	} else {
		m.RoutingPolicy = types.ObjectNull(aiEndpointRoutingPolicyAttrTypes)
	}
	if raw, ok := res.Spec["modelPolicy"].(map[string]any); ok {
		defaultModel, _ := raw["defaultModel"].(string)
		allowed, d := types.SetValueFrom(ctx, types.StringType, toStringSlice(raw["allowedModels"]))
		diags.Append(d...)
		obj, d := types.ObjectValue(aiEndpointModelPolicyAttrTypes, map[string]attr.Value{
			"default_model":  types.StringValue(defaultModel),
			"allowed_models": allowed,
		})
		diags.Append(d...)
		m.ModelPolicy = obj
	} else {
		m.ModelPolicy = types.ObjectNull(aiEndpointModelPolicyAttrTypes)
	}
	return diags
}
