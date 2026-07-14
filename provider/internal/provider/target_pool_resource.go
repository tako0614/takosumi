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

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

var targetCapabilityLevels = []string{"native", "shim", "emulated", "unsupported"}

var (
	_ resource.Resource              = (*targetPoolResource)(nil)
	_ resource.ResourceWithConfigure = (*targetPoolResource)(nil)
)

type targetPoolResource struct {
	data *providerData
}

func NewTargetPoolResource() resource.Resource {
	return &targetPoolResource{}
}

type targetPoolModel struct {
	ID      types.String `tfsdk:"id"`
	Name    types.String `tfsdk:"name"`
	Space   types.String `tfsdk:"space"`
	Targets types.List   `tfsdk:"target"`
}

type targetPoolTargetModel struct {
	Name            types.String `tfsdk:"name"`
	Type            types.String `tfsdk:"type"`
	Ref             types.String `tfsdk:"ref"`
	CredentialRef   types.String `tfsdk:"credential_ref"`
	Region          types.String `tfsdk:"region"`
	Priority        types.Int64  `tfsdk:"priority"`
	Implementations types.List   `tfsdk:"implementation"`
}

type targetPoolImplementationModel struct {
	Shape              types.String `tfsdk:"shape"`
	Implementation     types.String `tfsdk:"implementation"`
	NativeResourceType types.String `tfsdk:"native_resource_type"`
	Plugin             types.String `tfsdk:"plugin"`
	ProviderSource     types.String `tfsdk:"provider_source"`
	ProviderAlias      types.String `tfsdk:"provider_alias"`
	ProviderConfigJSON types.String `tfsdk:"provider_config_json"`
	ModuleTemplate     types.String `tfsdk:"module_template"`
	ModuleInputsJSON   types.String `tfsdk:"module_input_mappings_json"`
	ModuleOutputsJSON  types.String `tfsdk:"module_outputs_json"`
	OptionsJSON        types.String `tfsdk:"options_json"`
	Interfaces         types.Map    `tfsdk:"interfaces"`
}

var targetPoolImplementationAttrTypes = map[string]attr.Type{
	"shape":                      types.StringType,
	"implementation":             types.StringType,
	"native_resource_type":       types.StringType,
	"plugin":                     types.StringType,
	"provider_source":            types.StringType,
	"provider_alias":             types.StringType,
	"provider_config_json":       types.StringType,
	"module_template":            types.StringType,
	"module_input_mappings_json": types.StringType,
	"module_outputs_json":        types.StringType,
	"options_json":               types.StringType,
	"interfaces":                 types.MapType{ElemType: types.StringType},
}

var targetPoolTargetAttrTypes = map[string]attr.Type{
	"name":           types.StringType,
	"type":           types.StringType,
	"ref":            types.StringType,
	"credential_ref": types.StringType,
	"region":         types.StringType,
	"priority":       types.Int64Type,
	"implementation": types.ListType{ElemType: types.ObjectType{AttrTypes: targetPoolImplementationAttrTypes}},
}

func (r *targetPoolResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_target_pool"
}

func (r *targetPoolResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A Takosumi TargetPool admin resource. Each implementation carries complete provider/module or plugin execution evidence; the provider binary does not infer a backend from target type, shape, or implementation names.",
		Attributes: map[string]schema.Attribute{
			"name": schema.StringAttribute{
				Required:    true,
				Description: "TargetPool name. Changing it replaces the resource.",
				Validators: []validator.String{
					StringToken(),
				},
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"space": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Space for this TargetPool. Overrides the provider default; changing it replaces the resource.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"target": schema.ListNestedAttribute{
				Required:    true,
				Description: "Ranked Targets available to the Resolver. Type is an opaque operator-owned token and never selects a provider implicitly.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"name": schema.StringAttribute{
							Required:    true,
							Description: "Target name.",
							Validators: []validator.String{
								StringToken(),
							},
						},
						"type": schema.StringAttribute{
							Required:    true,
							Description: "Opaque operator-owned Target type token. Takosumi Core does not attach vendor semantics to this value.",
							Validators: []validator.String{
								StringToken(),
							},
						},
						"ref": schema.StringAttribute{
							Optional:    true,
							Description: "Type-specific external reference, such as an account id, cluster id, endpoint URL, or provider base URL.",
						},
						"credential_ref": schema.StringAttribute{
							Optional:    true,
							Description: "ProviderConnection or Credential id used by adapters that need provider credentials. This is deliberately separate from ref, which is the target-native reference.",
						},
						"region": schema.StringAttribute{
							Optional:    true,
							Description: "Optional region token.",
							Validators: []validator.String{
								StringToken(),
							},
						},
						"priority": schema.Int64Attribute{
							Required:    true,
							Description: "Higher priority wins after policy and capability filtering.",
						},
						"implementation": schema.ListNestedAttribute{
							Optional:    true,
							Description: "Optional operator-defined implementation capabilities for this Target. Unknown implementation/vendor names are intentionally allowed and are validated by the Takosumi endpoint, policy, and engine.",
							NestedObject: schema.NestedAttributeObject{
								Attributes: map[string]schema.Attribute{
									"shape": schema.StringAttribute{
										Required:    true,
										Description: "Resource shape kind this implementation can materialize, for example ContainerService.",
										Validators: []validator.String{
											StringToken(),
										},
									},
									"implementation": schema.StringAttribute{
										Required:    true,
										Description: "Opaque operator-owned implementation token. This is not a provider-binary enum.",
										Validators: []validator.String{
											StringToken(),
										},
									},
									"native_resource_type": schema.StringAttribute{
										Optional:    true,
										Description: "Optional opaque native resource type exposed in ResolutionLock evidence.",
										Validators: []validator.String{
											StringToken(),
										},
									},
									"plugin": schema.StringAttribute{
										Optional:    true,
										Description: "Optional adapter plugin id for this implementation. This is a Vite-style extension hook for hosts that inject a plugin-aware Resource Shape adapter; the stock OpenTofu-backed adapter rejects plugin-backed implementations instead of silently ignoring them.",
										Validators: []validator.String{
											StringToken(),
										},
									},
									"provider_source": schema.StringAttribute{
										Optional:    true,
										Description: "Explicit OpenTofu provider source for a module-backed implementation, such as namespace/type or hostname/namespace/type.",
									},
									"provider_alias": schema.StringAttribute{
										Optional:    true,
										Description: "Optional explicit provider alias. It is never derived from Target type.",
									},
									"provider_config_json": schema.StringAttribute{
										Optional:    true,
										Description: "Explicit non-secret provider block configuration as a JSON object. Provider credentials stay in ProviderConnection/CredentialRecipe.",
									},
									"module_template": schema.StringAttribute{
										Optional:    true,
										Description: "Explicit bundled module template id for a module-backed implementation.",
									},
									"module_input_mappings_json": schema.StringAttribute{
										Optional:    true,
										Description: "JSON object mapping child-module variable names to explicit spec, target, or literal projections.",
									},
									"module_outputs_json": schema.StringAttribute{
										Optional:    true,
										Description: "JSON array of public child outputs, each with name and type.",
									},
									"options_json": schema.StringAttribute{
										Optional:    true,
										Description: "Optional plugin-local JSON object. Secret material must stay in Credential or ProviderConnection, not in this field.",
									},
									"interfaces": schema.MapAttribute{
										Required:    true,
										ElementType: types.StringType,
										Description: "Map of interface/profile token to capability level. Levels are native, shim, emulated, or unsupported. Keys are extensible capability tokens.",
									},
								},
							},
						},
					},
				},
			},
			"id": schema.StringAttribute{
				Computed:    true,
				Description: "Takosumi TargetPool identifier.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
		},
	}
}

func (r *targetPoolResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *targetPoolResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan targetPoolModel
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

func (r *targetPoolResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state targetPoolModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	readSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	record, err := r.data.client.GetTargetPool(ctx, state.Name.ValueString(), readSpace)
	if err != nil {
		if errors.Is(err, client.ErrNotFound) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Failed to read TargetPool", err.Error())
		return
	}
	applyTargetPoolRecord(record, readSpace, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *targetPoolResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var plan targetPoolModel
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

func (r *targetPoolResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	var state targetPoolModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	deleteSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	if err := r.data.client.DeleteTargetPool(ctx, state.Name.ValueString(), deleteSpace); err != nil {
		resp.Diagnostics.AddError("Failed to delete TargetPool", err.Error())
	}
}

func (r *targetPoolResource) assertConfigured(diags *diag.Diagnostics) bool {
	if r.data == nil || r.data.client == nil {
		diags.AddError("Provider not configured", "Configure the Takosumi provider before using this resource.")
		return false
	}
	return true
}

func (r *targetPoolResource) put(ctx context.Context, plan *targetPoolModel, diags *diag.Diagnostics) {
	space, spec, d := plan.toSpec(ctx, r.data.defaultSpace)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	record, err := r.data.client.PutTargetPool(ctx, plan.Name.ValueString(), space, spec)
	if err != nil {
		diags.AddError("Failed to apply TargetPool", err.Error())
		return
	}
	applyTargetPoolRecord(record, space, plan)
}

func (m targetPoolModel) toSpec(ctx context.Context, defaultSpace string) (string, client.TargetPoolSpec, diag.Diagnostics) {
	var diags diag.Diagnostics
	space := effectiveSpace(m.Space, defaultSpace)
	if space == "" {
		diags.AddAttributeError(
			path.Root("space"),
			"Missing Space",
			"Set the resource `space` attribute or the provider `space` attribute.",
		)
		return "", client.TargetPoolSpec{}, diags
	}
	if m.Targets.IsNull() || m.Targets.IsUnknown() {
		diags.AddAttributeError(path.Root("target"), "Missing targets", "At least one target is required.")
		return space, client.TargetPoolSpec{}, diags
	}

	var targets []targetPoolTargetModel
	diags.Append(m.Targets.ElementsAs(ctx, &targets, false)...)
	if diags.HasError() {
		return space, client.TargetPoolSpec{}, diags
	}
	if len(targets) == 0 {
		diags.AddAttributeError(path.Root("target"), "Missing targets", "At least one target is required.")
		return space, client.TargetPoolSpec{}, diags
	}

	spec := client.TargetPoolSpec{Targets: make([]client.TargetPoolEntry, 0, len(targets))}
	for index, target := range targets {
		entry := client.TargetPoolEntry{
			Name:     target.Name.ValueString(),
			Type:     target.Type.ValueString(),
			Priority: target.Priority.ValueInt64(),
		}
		if strings.TrimSpace(entry.Name) == "" {
			diags.AddAttributeError(path.Root("target").AtListIndex(index).AtName("name"), "Invalid target name", "target.name must not be blank.")
		}
		if strings.TrimSpace(entry.Type) == "" {
			diags.AddAttributeError(path.Root("target").AtListIndex(index).AtName("type"), "Invalid target type", "target.type must not be blank.")
		}
		if !target.Ref.IsNull() && !target.Ref.IsUnknown() {
			entry.Ref = target.Ref.ValueString()
		}
		if !target.CredentialRef.IsNull() && !target.CredentialRef.IsUnknown() {
			entry.CredentialRef = target.CredentialRef.ValueString()
		}
		if !target.Region.IsNull() && !target.Region.IsUnknown() {
			entry.Region = target.Region.ValueString()
		}
		implementations, d := targetPoolImplementations(ctx, index, target.Implementations)
		diags.Append(d...)
		entry.Implementations = implementations
		spec.Targets = append(spec.Targets, entry)
	}
	return space, spec, diags
}

func targetPoolImplementations(ctx context.Context, targetIndex int, value types.List) ([]client.TargetImplementationDescriptor, diag.Diagnostics) {
	var diags diag.Diagnostics
	if value.IsNull() || value.IsUnknown() {
		return nil, diags
	}
	var raw []targetPoolImplementationModel
	diags.Append(value.ElementsAs(ctx, &raw, false)...)
	if diags.HasError() {
		return nil, diags
	}
	implementations := make([]client.TargetImplementationDescriptor, 0, len(raw))
	for index, item := range raw {
		implementationPath := path.Root("target").AtListIndex(targetIndex).AtName("implementation").AtListIndex(index)
		interfaces, d := targetPoolInterfaces(ctx, targetIndex, index, item.Interfaces)
		diags.Append(d...)
		impl := client.TargetImplementationDescriptor{
			Shape:          item.Shape.ValueString(),
			Implementation: item.Implementation.ValueString(),
			Interfaces:     interfaces,
		}
		if strings.TrimSpace(impl.Shape) == "" {
			diags.AddAttributeError(
				path.Root("target").AtListIndex(targetIndex).AtName("implementation").AtListIndex(index).AtName("shape"),
				"Invalid implementation shape",
				"implementation.shape must not be blank.",
			)
		}
		if strings.TrimSpace(impl.Implementation) == "" {
			diags.AddAttributeError(
				path.Root("target").AtListIndex(targetIndex).AtName("implementation").AtListIndex(index).AtName("implementation"),
				"Invalid implementation token",
				"implementation.implementation must not be blank.",
			)
		}
		if !item.NativeResourceType.IsNull() && !item.NativeResourceType.IsUnknown() {
			impl.NativeResourceType = item.NativeResourceType.ValueString()
		}
		if !item.Plugin.IsNull() && !item.Plugin.IsUnknown() {
			impl.Plugin = item.Plugin.ValueString()
		}
		if !item.ProviderSource.IsNull() && !item.ProviderSource.IsUnknown() {
			impl.ProviderSource = item.ProviderSource.ValueString()
		}
		if !item.ProviderAlias.IsNull() && !item.ProviderAlias.IsUnknown() {
			impl.ProviderAlias = item.ProviderAlias.ValueString()
		}
		if !item.ModuleTemplate.IsNull() && !item.ModuleTemplate.IsUnknown() {
			impl.ModuleTemplate = item.ModuleTemplate.ValueString()
		}
		impl.ProviderConfig = decodeJSONObjectAttribute(
			item.ProviderConfigJSON,
			implementationPath.AtName("provider_config_json"),
			"provider_config_json",
			&diags,
		)
		impl.ModuleInputMappings = decodeJSONObjectAttribute(
			item.ModuleInputsJSON,
			implementationPath.AtName("module_input_mappings_json"),
			"module_input_mappings_json",
			&diags,
		)
		impl.ModuleOutputs = decodeModuleOutputsAttribute(
			item.ModuleOutputsJSON,
			implementationPath.AtName("module_outputs_json"),
			&diags,
		)
		impl.Options = decodeJSONObjectAttribute(
			item.OptionsJSON,
			implementationPath.AtName("options_json"),
			"options_json",
			&diags,
		)
		if diags.HasError() {
			continue
		}
		implementations = append(implementations, impl)
	}
	return implementations, diags
}

func targetPoolInterfaces(ctx context.Context, targetIndex int, implementationIndex int, value types.Map) (map[string]string, diag.Diagnostics) {
	var diags diag.Diagnostics
	if value.IsNull() || value.IsUnknown() {
		diags.AddAttributeError(
			path.Root("target").AtListIndex(targetIndex).AtName("implementation").AtListIndex(implementationIndex).AtName("interfaces"),
			"Missing interfaces",
			"implementation.interfaces is required.",
		)
		return nil, diags
	}
	raw := map[string]types.String{}
	diags.Append(value.ElementsAs(ctx, &raw, false)...)
	if diags.HasError() {
		return nil, diags
	}
	interfaces := make(map[string]string, len(raw))
	for key, value := range raw {
		level := value.ValueString()
		if !containsString(targetCapabilityLevels, level) {
			diags.AddAttributeError(
				path.Root("target").AtListIndex(targetIndex).AtName("implementation").AtListIndex(implementationIndex).AtName("interfaces"),
				"Invalid capability level",
				fmt.Sprintf("%q for %q is not valid; must be one of: %s", level, key, strings.Join(targetCapabilityLevels, ", ")),
			)
			continue
		}
		interfaces[key] = level
	}
	return interfaces, diags
}

func decodeJSONObjectAttribute(value types.String, attributePath path.Path, field string, diags *diag.Diagnostics) map[string]any {
	if value.IsNull() || value.IsUnknown() || strings.TrimSpace(value.ValueString()) == "" {
		return nil
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(value.ValueString()), &decoded); err != nil || decoded == nil {
		diags.AddAttributeError(
			attributePath,
			"Invalid JSON object",
			fmt.Sprintf("implementation.%s must be a JSON object when set.", field),
		)
		return nil
	}
	return decoded
}

func decodeModuleOutputsAttribute(value types.String, attributePath path.Path, diags *diag.Diagnostics) []client.TargetModuleOutput {
	if value.IsNull() || value.IsUnknown() || strings.TrimSpace(value.ValueString()) == "" {
		return nil
	}
	var decoded []client.TargetModuleOutput
	if err := json.Unmarshal([]byte(value.ValueString()), &decoded); err != nil || decoded == nil {
		diags.AddAttributeError(
			attributePath,
			"Invalid module outputs JSON",
			"implementation.module_outputs_json must be a JSON array when set.",
		)
		return nil
	}
	return decoded
}

func applyTargetPoolRecord(record *client.TargetPoolRecord, fallbackSpace string, m *targetPoolModel) {
	space := record.SpaceID
	if space == "" {
		space = fallbackSpace
	}
	if record.ID != "" {
		m.ID = types.StringValue(record.ID)
	} else {
		m.ID = types.StringValue(fmt.Sprintf("tkrn:%s:TargetPool:%s", space, m.Name.ValueString()))
	}
	if space != "" {
		m.Space = types.StringValue(space)
	}
	if record.Name != "" {
		m.Name = types.StringValue(record.Name)
	}
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
