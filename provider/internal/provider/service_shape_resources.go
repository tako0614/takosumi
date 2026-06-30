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
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

var (
	_ resource.Resource                = (*serviceShapeResource)(nil)
	_ resource.ResourceWithConfigure   = (*serviceShapeResource)(nil)
	_ resource.ResourceWithImportState = (*serviceShapeResource)(nil)
	_ resource.ResourceWithModifyPlan  = (*serviceShapeResource)(nil)
)

type serviceShapeConfig struct {
	typeSuffix  string
	kind        string
	description string
	spec        serviceShapeSpecKind
}

type serviceShapeSpecKind string

const (
	specObjectBucket     serviceShapeSpecKind = "object_bucket"
	specKVStore          serviceShapeSpecKind = "kv_store"
	specQueue            serviceShapeSpecKind = "queue"
	specPushNotification serviceShapeSpecKind = "push_notification"
	specSQLDatabase      serviceShapeSpecKind = "sql_database"
	specContainerService serviceShapeSpecKind = "container_service"
)

var pushNotificationProtocols = []string{"web_push", "apns", "fcm"}

type serviceShapeResource struct {
	data *providerData
	cfg  serviceShapeConfig
}

type serviceShapeModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Interfaces             types.Set    `tfsdk:"interfaces"`
	Consistency            types.String `tfsdk:"consistency"`
	MaxRetries             types.Int64  `tfsdk:"max_retries"`
	MaxBatchSize           types.Int64  `tfsdk:"max_batch_size"`
	Protocols              types.Set    `tfsdk:"protocols"`
	TTLSeconds             types.Int64  `tfsdk:"ttl_seconds"`
	Engine                 types.String `tfsdk:"engine"`
	MigrationsPath         types.String `tfsdk:"migrations_path"`
	Image                  types.String `tfsdk:"image"`
	Ports                  types.Set    `tfsdk:"ports"`
	PublicHTTP             types.Bool   `tfsdk:"public_http"`
	Environment            types.Map    `tfsdk:"environment"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type objectBucketModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Interfaces             types.Set    `tfsdk:"interfaces"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type kvStoreModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Consistency            types.String `tfsdk:"consistency"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type queueModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	MaxRetries             types.Int64  `tfsdk:"max_retries"`
	MaxBatchSize           types.Int64  `tfsdk:"max_batch_size"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type pushNotificationModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Protocols              types.Set    `tfsdk:"protocols"`
	TTLSeconds             types.Int64  `tfsdk:"ttl_seconds"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type sqlDatabaseModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Engine                 types.String `tfsdk:"engine"`
	MigrationsPath         types.String `tfsdk:"migrations_path"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type containerServiceModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Image                  types.String `tfsdk:"image"`
	Ports                  types.Set    `tfsdk:"ports"`
	PublicHTTP             types.Bool   `tfsdk:"public_http"`
	Environment            types.Map    `tfsdk:"environment"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

func (m objectBucketModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.Interfaces = m.Interfaces
	return base
}

func objectBucketModelFromServiceShape(m serviceShapeModel) objectBucketModel {
	return objectBucketModel{
		ID:                     m.ID,
		Name:                   m.Name,
		Interfaces:             m.Interfaces,
		Space:                  m.Space,
		TargetPool:             m.TargetPool,
		SelectedImplementation: m.SelectedImplementation,
		Target:                 m.Target,
		Locked:                 m.Locked,
		Portability:            m.Portability,
		Outputs:                m.Outputs,
	}
}

func (m kvStoreModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.Consistency = m.Consistency
	return base
}

func kvStoreModelFromServiceShape(m serviceShapeModel) kvStoreModel {
	return kvStoreModel{
		ID:                     m.ID,
		Name:                   m.Name,
		Consistency:            m.Consistency,
		Space:                  m.Space,
		TargetPool:             m.TargetPool,
		SelectedImplementation: m.SelectedImplementation,
		Target:                 m.Target,
		Locked:                 m.Locked,
		Portability:            m.Portability,
		Outputs:                m.Outputs,
	}
}

func (m queueModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.MaxRetries = m.MaxRetries
	base.MaxBatchSize = m.MaxBatchSize
	return base
}

func queueModelFromServiceShape(m serviceShapeModel) queueModel {
	return queueModel{
		ID:                     m.ID,
		Name:                   m.Name,
		MaxRetries:             m.MaxRetries,
		MaxBatchSize:           m.MaxBatchSize,
		Space:                  m.Space,
		TargetPool:             m.TargetPool,
		SelectedImplementation: m.SelectedImplementation,
		Target:                 m.Target,
		Locked:                 m.Locked,
		Portability:            m.Portability,
		Outputs:                m.Outputs,
	}
}

func (m pushNotificationModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.Protocols = m.Protocols
	base.TTLSeconds = m.TTLSeconds
	return base
}

func pushNotificationModelFromServiceShape(m serviceShapeModel) pushNotificationModel {
	return pushNotificationModel{
		ID:                     m.ID,
		Name:                   m.Name,
		Protocols:              m.Protocols,
		TTLSeconds:             m.TTLSeconds,
		Space:                  m.Space,
		TargetPool:             m.TargetPool,
		SelectedImplementation: m.SelectedImplementation,
		Target:                 m.Target,
		Locked:                 m.Locked,
		Portability:            m.Portability,
		Outputs:                m.Outputs,
	}
}

func (m sqlDatabaseModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.Engine = m.Engine
	base.MigrationsPath = m.MigrationsPath
	return base
}

func sqlDatabaseModelFromServiceShape(m serviceShapeModel) sqlDatabaseModel {
	return sqlDatabaseModel{
		ID:                     m.ID,
		Name:                   m.Name,
		Engine:                 m.Engine,
		MigrationsPath:         m.MigrationsPath,
		Space:                  m.Space,
		TargetPool:             m.TargetPool,
		SelectedImplementation: m.SelectedImplementation,
		Target:                 m.Target,
		Locked:                 m.Locked,
		Portability:            m.Portability,
		Outputs:                m.Outputs,
	}
}

func (m containerServiceModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.Image = m.Image
	base.Ports = m.Ports
	base.PublicHTTP = m.PublicHTTP
	base.Environment = m.Environment
	return base
}

func containerServiceModelFromServiceShape(m serviceShapeModel) containerServiceModel {
	return containerServiceModel{
		ID:                     m.ID,
		Name:                   m.Name,
		Image:                  m.Image,
		Ports:                  m.Ports,
		PublicHTTP:             m.PublicHTTP,
		Environment:            m.Environment,
		Space:                  m.Space,
		TargetPool:             m.TargetPool,
		SelectedImplementation: m.SelectedImplementation,
		Target:                 m.Target,
		Locked:                 m.Locked,
		Portability:            m.Portability,
		Outputs:                m.Outputs,
	}
}

func serviceShapeModelFromCommon(
	id types.String,
	name types.String,
	space types.String,
	targetPool types.String,
	selectedImplementation types.String,
	target types.String,
	locked types.Bool,
	portability types.String,
	outputs types.Map,
) serviceShapeModel {
	return serviceShapeModel{
		ID:                     id,
		Name:                   name,
		Space:                  space,
		TargetPool:             targetPool,
		SelectedImplementation: selectedImplementation,
		Target:                 target,
		Locked:                 locked,
		Portability:            portability,
		Outputs:                outputs,
	}
}

func NewObjectBucketResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix:  "object_bucket",
		kind:        client.KindObjectBucket,
		description: "Provider-neutral object bucket. Data-plane access stays S3-compatible; this shape exists when Takosumi owns binding, policy, metering, or managed target placement.",
		spec:        specObjectBucket,
	}}
}

func NewKVStoreResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix:  "kv_store",
		kind:        client.KindKVStore,
		description: "Provider-neutral key-value store for runtime bindings and small metadata/state use cases.",
		spec:        specKVStore,
	}}
}

func NewQueueResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix:  "queue",
		kind:        client.KindQueue,
		description: "Provider-neutral queue for async jobs, delivery, and event fan-out.",
		spec:        specQueue,
	}}
}

func NewPushNotificationResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix:  "push_notification",
		kind:        client.KindPushNotification,
		description: "Provider-neutral push notification channel for Web Push, APNs, and FCM delivery. Credentials are supplied by Takosumi Target/Credential wiring, not by this resource spec.",
		spec:        specPushNotification,
	}}
}

func NewSQLDatabaseResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix:  "sql_database",
		kind:        client.KindSQLDatabase,
		description: "Provider-neutral SQL database shape. Use sqlite for D1-like serverless SQL, or postgres/mysql when an operator target advertises those capabilities.",
		spec:        specSQLDatabase,
	}}
}

func NewContainerServiceResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix:  "container_service",
		kind:        client.KindContainerService,
		description: "Provider-neutral OCI container service. This is intentionally separate from EdgeWorker.",
		spec:        specContainerService,
	}}
}

func (r *serviceShapeResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_" + r.cfg.typeSuffix
}

func (r *serviceShapeResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	attrs := commonServiceShapeAttributes()
	switch r.cfg.spec {
	case specObjectBucket:
		attrs["interfaces"] = schema.SetAttribute{
			Optional:    true,
			ElementType: types.StringType,
			Description: "Optional object-storage interface tokens, for example s3_api, signed_url, or object_events.",
			Validators:  []validator.Set{SetStringsNonEmpty(0)},
		}
	case specKVStore:
		attrs["consistency"] = schema.StringAttribute{
			Optional:    true,
			Description: "Optional consistency preference: eventual or strong.",
			Validators:  []validator.String{StringOneOf("eventual", "strong")},
		}
	case specQueue:
		attrs["max_retries"] = schema.Int64Attribute{
			Optional:    true,
			Description: "Optional delivery retry preference. The selected adapter decides support.",
		}
		attrs["max_batch_size"] = schema.Int64Attribute{
			Optional:    true,
			Description: "Optional consumer batch size preference. The selected adapter decides support.",
		}
	case specPushNotification:
		attrs["protocols"] = schema.SetAttribute{
			Optional:    true,
			ElementType: types.StringType,
			Description: "Optional push protocols. Allowed values: web_push, apns, fcm. Defaults to web_push when omitted.",
			Validators:  []validator.Set{SetStringsOneOf(0, pushNotificationProtocols...)},
		}
		attrs["ttl_seconds"] = schema.Int64Attribute{
			Optional:    true,
			Description: "Optional notification TTL in seconds. The selected adapter decides support and limits.",
		}
	case specSQLDatabase:
		attrs["engine"] = schema.StringAttribute{
			Optional:    true,
			Description: "Optional SQL engine token: sqlite, postgres, or mysql.",
			Validators:  []validator.String{StringOneOf("sqlite", "postgres", "mysql")},
		}
		attrs["migrations_path"] = schema.StringAttribute{
			Optional:    true,
			Description: "Optional OpenTofu-runner-local migrations path. Takosumi does not invent product-specific DB migration code.",
		}
	case specContainerService:
		attrs["image"] = schema.StringAttribute{
			Required:    true,
			Description: "OCI image reference.",
		}
		attrs["ports"] = schema.SetAttribute{
			Optional:    true,
			ElementType: types.Int64Type,
			Description: "Container ports requested by the service.",
		}
		attrs["public_http"] = schema.BoolAttribute{
			Optional:    true,
			Description: "Whether this container asks for public HTTP exposure.",
		}
		attrs["environment"] = schema.MapAttribute{
			Optional:    true,
			ElementType: types.StringType,
			Description: "Non-secret environment variables. Secrets and AI keys must come from ProviderConnection/Secret projection, not this map.",
		}
	}
	resp.Schema = schema.Schema{
		Description: r.cfg.description,
		Attributes:  attrs,
	}
}

func commonServiceShapeAttributes() map[string]schema.Attribute {
	return map[string]schema.Attribute{
		"name": schema.StringAttribute{
			Required:    true,
			Description: "Resource name. Changing it replaces the resource.",
			PlanModifiers: []planmodifier.String{
				stringplanmodifier.RequiresReplace(),
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
	}
}

func (r *serviceShapeResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *serviceShapeResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	plan, diags := r.modelFromPlan(ctx, req.Plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(r.setState(ctx, &resp.State, plan)...)
}

func (r *serviceShapeResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	state, diags := r.modelFromState(ctx, req.State)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	readSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	res, err := r.data.client.GetResource(ctx, r.cfg.kind, state.Name.ValueString(), readSpace)
	if err != nil {
		if errors.Is(err, client.ErrNotFound) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Failed to read "+r.cfg.kind, err.Error())
		return
	}
	space := state.Space.ValueString()
	if res.Metadata.Space != "" {
		space = res.Metadata.Space
	}
	resp.Diagnostics.Append(refreshServiceShapeSpec(ctx, res, r.cfg.spec, &state)...)
	resp.Diagnostics.Append(applyServiceShapeStatus(ctx, res, r.cfg.kind, space, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(r.setState(ctx, &resp.State, state)...)
}

func (r *serviceShapeResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	plan, diags := r.modelFromPlan(ctx, req.Plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(r.setState(ctx, &resp.State, plan)...)
}

func (r *serviceShapeResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	if !r.assertConfigured(&resp.Diagnostics) {
		return
	}
	state, diags := r.modelFromState(ctx, req.State)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	deleteSpace := effectiveSpace(state.Space, r.data.defaultSpace)
	if err := r.data.client.DeleteResource(ctx, r.cfg.kind, state.Name.ValueString(), deleteSpace); err != nil {
		resp.Diagnostics.AddError("Failed to delete "+r.cfg.kind, err.Error())
	}
}

func (r *serviceShapeResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if space, name, ok := cutSpaceName(req.ID); ok {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("space"), space)...)
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), name)...)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("name"), req.ID)...)
}

func (r *serviceShapeResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, _ *resource.ModifyPlanResponse) {
	if r.data == nil || req.Plan.Raw.IsNull() {
		return
	}
	plan, diags := r.modelFromPlan(ctx, req.Plan)
	if diags.HasError() {
		return
	}
	if plan.Name.IsUnknown() {
		return
	}
	body, _, d := plan.toResource(ctx, r.data.defaultSpace, r.cfg.kind, r.cfg.spec)
	if d.HasError() {
		return
	}
	_, _ = r.data.client.PreviewResource(ctx, body)
}

func (r *serviceShapeResource) modelFromPlan(ctx context.Context, plan tfsdk.Plan) (serviceShapeModel, diag.Diagnostics) {
	switch r.cfg.spec {
	case specObjectBucket:
		var m objectBucketModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specKVStore:
		var m kvStoreModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specQueue:
		var m queueModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specPushNotification:
		var m pushNotificationModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specSQLDatabase:
		var m sqlDatabaseModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specContainerService:
		var m containerServiceModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	default:
		var diags diag.Diagnostics
		diags.AddError("Unsupported service shape", "The provider cannot decode this service shape plan.")
		return serviceShapeModel{}, diags
	}
}

func (r *serviceShapeResource) modelFromState(ctx context.Context, state tfsdk.State) (serviceShapeModel, diag.Diagnostics) {
	switch r.cfg.spec {
	case specObjectBucket:
		var m objectBucketModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specKVStore:
		var m kvStoreModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specQueue:
		var m queueModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specPushNotification:
		var m pushNotificationModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specSQLDatabase:
		var m sqlDatabaseModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specContainerService:
		var m containerServiceModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	default:
		var diags diag.Diagnostics
		diags.AddError("Unsupported service shape", "The provider cannot decode this service shape state.")
		return serviceShapeModel{}, diags
	}
}

func (r *serviceShapeResource) setState(ctx context.Context, state *tfsdk.State, m serviceShapeModel) diag.Diagnostics {
	switch r.cfg.spec {
	case specObjectBucket:
		return state.Set(ctx, objectBucketModelFromServiceShape(m))
	case specKVStore:
		return state.Set(ctx, kvStoreModelFromServiceShape(m))
	case specQueue:
		return state.Set(ctx, queueModelFromServiceShape(m))
	case specPushNotification:
		return state.Set(ctx, pushNotificationModelFromServiceShape(m))
	case specSQLDatabase:
		return state.Set(ctx, sqlDatabaseModelFromServiceShape(m))
	case specContainerService:
		return state.Set(ctx, containerServiceModelFromServiceShape(m))
	default:
		var diags diag.Diagnostics
		diags.AddError("Unsupported service shape", "The provider cannot encode this service shape state.")
		return diags
	}
}

func (r *serviceShapeResource) assertConfigured(diags *diag.Diagnostics) bool {
	if r.data == nil || r.data.client == nil {
		diags.AddError(
			"Provider not configured",
			"The takosumi provider was not configured before use. This is usually a provider bug.",
		)
		return false
	}
	if !r.data.capabilities.SupportsResource(r.cfg.kind) {
		diags.AddError(
			r.cfg.kind+" not supported",
			"The configured Takosumi endpoint does not advertise the "+r.cfg.kind+" resource shape.",
		)
		return false
	}
	return true
}

func (r *serviceShapeResource) put(ctx context.Context, plan *serviceShapeModel, diags *diag.Diagnostics) {
	body, space, d := plan.toResource(ctx, r.data.defaultSpace, r.cfg.kind, r.cfg.spec)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	res, err := r.data.client.PutResource(ctx, r.cfg.kind, plan.Name.ValueString(), body)
	if err != nil {
		diags.AddError("Failed to apply "+r.cfg.kind, err.Error())
		return
	}
	plan.Space = types.StringValue(space)
	diags.Append(applyServiceShapeStatus(ctx, res, r.cfg.kind, space, plan)...)
}

func (m serviceShapeModel) toResource(ctx context.Context, defaultSpace, kind string, specKind serviceShapeSpecKind) (*client.Resource, string, diag.Diagnostics) {
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
	spec := map[string]any{"name": name}
	switch specKind {
	case specObjectBucket:
		if !m.Interfaces.IsNull() && !m.Interfaces.IsUnknown() {
			var interfaces []string
			diags.Append(m.Interfaces.ElementsAs(ctx, &interfaces, false)...)
			if diags.HasError() {
				return nil, "", diags
			}
			if len(interfaces) > 0 {
				spec["interfaces"] = interfaces
			}
		}
	case specKVStore:
		if !m.Consistency.IsNull() && !m.Consistency.IsUnknown() && m.Consistency.ValueString() != "" {
			spec["consistency"] = m.Consistency.ValueString()
		}
	case specQueue:
		delivery := map[string]any{}
		if !m.MaxRetries.IsNull() && !m.MaxRetries.IsUnknown() {
			delivery["maxRetries"] = m.MaxRetries.ValueInt64()
		}
		if !m.MaxBatchSize.IsNull() && !m.MaxBatchSize.IsUnknown() {
			delivery["maxBatchSize"] = m.MaxBatchSize.ValueInt64()
		}
		if len(delivery) > 0 {
			spec["delivery"] = delivery
		}
	case specPushNotification:
		if !m.Protocols.IsNull() && !m.Protocols.IsUnknown() {
			var protocols []string
			diags.Append(m.Protocols.ElementsAs(ctx, &protocols, false)...)
			if diags.HasError() {
				return nil, "", diags
			}
			if len(protocols) > 0 {
				spec["protocols"] = protocols
			}
		}
		if !m.TTLSeconds.IsNull() && !m.TTLSeconds.IsUnknown() {
			spec["delivery"] = map[string]any{
				"ttlSeconds": m.TTLSeconds.ValueInt64(),
			}
		}
	case specSQLDatabase:
		if !m.Engine.IsNull() && !m.Engine.IsUnknown() && m.Engine.ValueString() != "" {
			spec["engine"] = m.Engine.ValueString()
		}
		if !m.MigrationsPath.IsNull() && !m.MigrationsPath.IsUnknown() && m.MigrationsPath.ValueString() != "" {
			spec["migrationsPath"] = m.MigrationsPath.ValueString()
		}
	case specContainerService:
		spec["image"] = m.Image.ValueString()
		if !m.Ports.IsNull() && !m.Ports.IsUnknown() {
			var ports []int64
			diags.Append(m.Ports.ElementsAs(ctx, &ports, false)...)
			if diags.HasError() {
				return nil, "", diags
			}
			if len(ports) > 0 {
				spec["ports"] = ports
			}
		}
		if !m.PublicHTTP.IsNull() && !m.PublicHTTP.IsUnknown() {
			spec["publicHttp"] = m.PublicHTTP.ValueBool()
		}
		if !m.Environment.IsNull() && !m.Environment.IsUnknown() {
			env := map[string]string{}
			diags.Append(m.Environment.ElementsAs(ctx, &env, false)...)
			if diags.HasError() {
				return nil, "", diags
			}
			if len(env) > 0 {
				spec["environment"] = env
			}
		}
	}
	targetPool := ""
	if !m.TargetPool.IsNull() && !m.TargetPool.IsUnknown() {
		targetPool = m.TargetPool.ValueString()
	}
	return &client.Resource{
		APIVersion: client.APIVersion,
		Kind:       kind,
		Metadata: client.Metadata{
			Name:      name,
			Space:     space,
			ManagedBy: client.ManagedByOpenTofu,
		},
		Spec:           spec,
		TargetPoolName: targetPool,
	}, space, diags
}

func applyServiceShapeStatus(ctx context.Context, res *client.Resource, kind, space string, m *serviceShapeModel) diag.Diagnostics {
	var diags diag.Diagnostics
	m.ID = types.StringValue(resourceIDForKind(res, space, kind, m.Name.ValueString()))
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

func refreshServiceShapeSpec(ctx context.Context, res *client.Resource, specKind serviceShapeSpecKind, m *serviceShapeModel) diag.Diagnostics {
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
	switch specKind {
	case specObjectBucket:
		if raw, ok := res.Spec["interfaces"]; ok {
			set, d := types.SetValueFrom(ctx, types.StringType, toStringSlice(raw))
			diags.Append(d...)
			m.Interfaces = set
		} else {
			m.Interfaces = types.SetNull(types.StringType)
		}
	case specKVStore:
		if v, ok := res.Spec["consistency"].(string); ok && v != "" {
			m.Consistency = types.StringValue(v)
		} else {
			m.Consistency = types.StringNull()
		}
	case specQueue:
		if raw, ok := res.Spec["delivery"].(map[string]any); ok {
			m.MaxRetries = int64FromSpec(raw["maxRetries"])
			m.MaxBatchSize = int64FromSpec(raw["maxBatchSize"])
		} else {
			m.MaxRetries = types.Int64Null()
			m.MaxBatchSize = types.Int64Null()
		}
	case specPushNotification:
		if raw, ok := res.Spec["protocols"]; ok {
			set, d := types.SetValueFrom(ctx, types.StringType, toStringSlice(raw))
			diags.Append(d...)
			m.Protocols = set
		} else {
			m.Protocols = types.SetNull(types.StringType)
		}
		if raw, ok := res.Spec["delivery"].(map[string]any); ok {
			m.TTLSeconds = int64FromSpec(raw["ttlSeconds"])
		} else {
			m.TTLSeconds = types.Int64Null()
		}
	case specSQLDatabase:
		if v, ok := res.Spec["engine"].(string); ok && v != "" {
			m.Engine = types.StringValue(v)
		} else {
			m.Engine = types.StringNull()
		}
		if v, ok := res.Spec["migrationsPath"].(string); ok && v != "" {
			m.MigrationsPath = types.StringValue(v)
		} else {
			m.MigrationsPath = types.StringNull()
		}
	case specContainerService:
		if v, ok := res.Spec["image"].(string); ok && v != "" {
			m.Image = types.StringValue(v)
		}
		if raw, ok := res.Spec["ports"]; ok {
			set, d := types.SetValueFrom(ctx, types.Int64Type, toInt64Slice(raw))
			diags.Append(d...)
			m.Ports = set
		} else {
			m.Ports = types.SetNull(types.Int64Type)
		}
		if v, ok := res.Spec["publicHttp"].(bool); ok {
			m.PublicHTTP = types.BoolValue(v)
		} else {
			m.PublicHTTP = types.BoolNull()
		}
		if raw, ok := res.Spec["environment"].(map[string]any); ok {
			env := map[string]string{}
			for key, value := range raw {
				if s, ok := value.(string); ok {
					env[key] = s
				}
			}
			value, d := types.MapValueFrom(ctx, types.StringType, env)
			diags.Append(d...)
			m.Environment = value
		} else {
			m.Environment = types.MapNull(types.StringType)
		}
	}
	return diags
}

func int64FromSpec(value any) types.Int64 {
	switch v := value.(type) {
	case int64:
		return types.Int64Value(v)
	case int:
		return types.Int64Value(int64(v))
	case float64:
		return types.Int64Value(int64(v))
	default:
		return types.Int64Null()
	}
}

func toInt64Slice(raw any) []int64 {
	switch v := raw.(type) {
	case []int64:
		return v
	case []any:
		out := make([]int64, 0, len(v))
		for _, item := range v {
			switch n := item.(type) {
			case int64:
				out = append(out, n)
			case int:
				out = append(out, int64(n))
			case float64:
				out = append(out, int64(n))
			}
		}
		return out
	default:
		return nil
	}
}
