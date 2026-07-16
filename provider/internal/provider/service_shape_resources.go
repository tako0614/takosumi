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
)

type serviceShapeConfig struct {
	typeSuffix  string
	kind        string
	description string
	spec        serviceShapeSpecKind
}

type serviceShapeSpecKind string

const (
	specObjectBucket           serviceShapeSpecKind = "object_bucket"
	specKVStore                serviceShapeSpecKind = "kv_store"
	specQueue                  serviceShapeSpecKind = "queue"
	specSQLDatabase            serviceShapeSpecKind = "sql_database"
	specContainerService       serviceShapeSpecKind = "container_service"
	specVectorIndex            serviceShapeSpecKind = "vector_index"
	specDurableWorkflow        serviceShapeSpecKind = "durable_workflow"
	specStatefulActorNamespace serviceShapeSpecKind = "stateful_actor_namespace"
	specSchedule               serviceShapeSpecKind = "schedule"
)

type serviceShapeResource struct {
	data *providerData
	cfg  serviceShapeConfig
}

type serviceShapeModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Interfaces             types.Set    `tfsdk:"interfaces"`
	StorageClass           types.String `tfsdk:"storage_class"`
	Consistency            types.String `tfsdk:"consistency"`
	MaxRetries             types.Int64  `tfsdk:"max_retries"`
	MaxBatchSize           types.Int64  `tfsdk:"max_batch_size"`
	Engine                 types.String `tfsdk:"engine"`
	MigrationsPath         types.String `tfsdk:"migrations_path"`
	Image                  types.String `tfsdk:"image"`
	Ports                  types.Set    `tfsdk:"ports"`
	PublicHTTP             types.Bool   `tfsdk:"public_http"`
	Environment            types.Map    `tfsdk:"environment"`
	Connections            types.List   `tfsdk:"connections"`
	Dimensions             types.Int64  `tfsdk:"dimensions"`
	Metric                 types.String `tfsdk:"metric"`
	ArtifactPath           types.String `tfsdk:"artifact_path"`
	ArtifactURL            types.String `tfsdk:"artifact_url"`
	ArtifactRef            types.String `tfsdk:"artifact_ref"`
	ArtifactSHA256         types.String `tfsdk:"artifact_sha256"`
	Entrypoint             types.String `tfsdk:"entrypoint"`
	MaxAttempts            types.Int64  `tfsdk:"max_attempts"`
	InitialBackoffSeconds  types.Int64  `tfsdk:"initial_backoff_seconds"`
	ClassName              types.String `tfsdk:"class_name"`
	StorageProfile         types.String `tfsdk:"storage_profile"`
	MigrationTag           types.String `tfsdk:"migration_tag"`
	Cron                   types.String `tfsdk:"cron"`
	Timezone               types.String `tfsdk:"timezone"`
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
	StorageClass           types.String `tfsdk:"storage_class"`
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
	Connections            types.List   `tfsdk:"connections"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type vectorIndexModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Dimensions             types.Int64  `tfsdk:"dimensions"`
	Metric                 types.String `tfsdk:"metric"`
	Connections            types.List   `tfsdk:"connections"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type durableWorkflowModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	ArtifactPath           types.String `tfsdk:"artifact_path"`
	ArtifactURL            types.String `tfsdk:"artifact_url"`
	ArtifactRef            types.String `tfsdk:"artifact_ref"`
	ArtifactSHA256         types.String `tfsdk:"artifact_sha256"`
	Entrypoint             types.String `tfsdk:"entrypoint"`
	MaxAttempts            types.Int64  `tfsdk:"max_attempts"`
	InitialBackoffSeconds  types.Int64  `tfsdk:"initial_backoff_seconds"`
	Connections            types.List   `tfsdk:"connections"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type statefulActorNamespaceModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	ClassName              types.String `tfsdk:"class_name"`
	StorageProfile         types.String `tfsdk:"storage_profile"`
	MigrationTag           types.String `tfsdk:"migration_tag"`
	Connections            types.List   `tfsdk:"connections"`
	Space                  types.String `tfsdk:"space"`
	TargetPool             types.String `tfsdk:"target_pool"`
	SelectedImplementation types.String `tfsdk:"selected_implementation"`
	Target                 types.String `tfsdk:"target"`
	Locked                 types.Bool   `tfsdk:"locked"`
	Portability            types.String `tfsdk:"portability"`
	Outputs                types.Map    `tfsdk:"outputs"`
}

type scheduleModel struct {
	ID                     types.String `tfsdk:"id"`
	Name                   types.String `tfsdk:"name"`
	Cron                   types.String `tfsdk:"cron"`
	Timezone               types.String `tfsdk:"timezone"`
	Connections            types.List   `tfsdk:"connections"`
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
	base.StorageClass = m.StorageClass
	return base
}

func objectBucketModelFromServiceShape(m serviceShapeModel) objectBucketModel {
	return objectBucketModel{
		ID:                     m.ID,
		Name:                   m.Name,
		Interfaces:             m.Interfaces,
		StorageClass:           m.StorageClass,
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
	base.Connections = m.Connections
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
		Connections:            m.Connections,
		Space:                  m.Space,
		TargetPool:             m.TargetPool,
		SelectedImplementation: m.SelectedImplementation,
		Target:                 m.Target,
		Locked:                 m.Locked,
		Portability:            m.Portability,
		Outputs:                m.Outputs,
	}
}

func (m vectorIndexModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.Dimensions = m.Dimensions
	base.Metric = m.Metric
	base.Connections = m.Connections
	return base
}

func vectorIndexModelFromServiceShape(m serviceShapeModel) vectorIndexModel {
	return vectorIndexModel{
		ID: m.ID, Name: m.Name, Dimensions: m.Dimensions, Metric: m.Metric,
		Connections: m.Connections, Space: m.Space, TargetPool: m.TargetPool,
		SelectedImplementation: m.SelectedImplementation, Target: m.Target,
		Locked: m.Locked, Portability: m.Portability, Outputs: m.Outputs,
	}
}

func (m durableWorkflowModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.ArtifactPath = m.ArtifactPath
	base.ArtifactURL = m.ArtifactURL
	base.ArtifactRef = m.ArtifactRef
	base.ArtifactSHA256 = m.ArtifactSHA256
	base.Entrypoint = m.Entrypoint
	base.MaxAttempts = m.MaxAttempts
	base.InitialBackoffSeconds = m.InitialBackoffSeconds
	base.Connections = m.Connections
	return base
}

func durableWorkflowModelFromServiceShape(m serviceShapeModel) durableWorkflowModel {
	return durableWorkflowModel{
		ID: m.ID, Name: m.Name, ArtifactPath: m.ArtifactPath,
		ArtifactURL: m.ArtifactURL, ArtifactRef: m.ArtifactRef,
		ArtifactSHA256: m.ArtifactSHA256, Entrypoint: m.Entrypoint,
		MaxAttempts: m.MaxAttempts, InitialBackoffSeconds: m.InitialBackoffSeconds,
		Connections: m.Connections, Space: m.Space, TargetPool: m.TargetPool,
		SelectedImplementation: m.SelectedImplementation, Target: m.Target,
		Locked: m.Locked, Portability: m.Portability, Outputs: m.Outputs,
	}
}

func (m statefulActorNamespaceModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.ClassName = m.ClassName
	base.StorageProfile = m.StorageProfile
	base.MigrationTag = m.MigrationTag
	base.Connections = m.Connections
	return base
}

func statefulActorNamespaceModelFromServiceShape(m serviceShapeModel) statefulActorNamespaceModel {
	return statefulActorNamespaceModel{
		ID: m.ID, Name: m.Name, ClassName: m.ClassName,
		StorageProfile: m.StorageProfile, MigrationTag: m.MigrationTag,
		Connections: m.Connections, Space: m.Space, TargetPool: m.TargetPool,
		SelectedImplementation: m.SelectedImplementation, Target: m.Target,
		Locked: m.Locked, Portability: m.Portability, Outputs: m.Outputs,
	}
}

func (m scheduleModel) toServiceShapeModel() serviceShapeModel {
	base := serviceShapeModelFromCommon(
		m.ID, m.Name, m.Space, m.TargetPool, m.SelectedImplementation,
		m.Target, m.Locked, m.Portability, m.Outputs,
	)
	base.Cron = m.Cron
	base.Timezone = m.Timezone
	base.Connections = m.Connections
	return base
}

func scheduleModelFromServiceShape(m serviceShapeModel) scheduleModel {
	return scheduleModel{
		ID: m.ID, Name: m.Name, Cron: m.Cron, Timezone: m.Timezone,
		Connections: m.Connections, Space: m.Space, TargetPool: m.TargetPool,
		SelectedImplementation: m.SelectedImplementation, Target: m.Target,
		Locked: m.Locked, Portability: m.Portability, Outputs: m.Outputs,
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

func NewSQLDatabaseResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix:  "sql_database",
		kind:        client.KindSQLDatabase,
		description: "Provider-neutral SQL database shape. Engine is an open capability token and requires explicit operator Target support.",
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

func NewVectorIndexResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix: "vector_index", kind: client.KindVectorIndex,
		description: "Provider-neutral vector index with explicit dimensions and similarity metric capability.",
		spec:        specVectorIndex,
	}}
}

func NewDurableWorkflowResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix: "durable_workflow", kind: client.KindDurableWorkflow,
		description: "Provider-neutral durable workflow backed by an immutable prebuilt artifact.",
		spec:        specDurableWorkflow,
	}}
}

func NewStatefulActorNamespaceResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix: "stateful_actor_namespace", kind: client.KindStatefulActorNamespace,
		description: "Namespace-level lifecycle for stateful actors. Individual actor instances are runtime state and never Resource objects.",
		spec:        specStatefulActorNamespace,
	}}
}

func NewScheduleResource() resource.Resource {
	return &serviceShapeResource{cfg: serviceShapeConfig{
		typeSuffix: "schedule", kind: client.KindSchedule,
		description: "Portable five-field cron schedule targeting exactly one invokable Resource connection.",
		spec:        specSchedule,
	}}
}

func (r *serviceShapeResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_" + r.cfg.typeSuffix
}

func (r *serviceShapeResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	attrs := commonServiceShapeAttributes()
	switch r.cfg.spec {
	case specObjectBucket:
		attrs["storage_class"] = schema.StringAttribute{
			Optional:    true,
			Computed:    true,
			Description: "Portable storage class for newly written objects: standard or infrequent_access. Omission materializes as standard without forcing a plan diff for pre-field state.",
			Validators:  []validator.String{StringOneOf("standard", "infrequent_access")},
		}
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
	case specSQLDatabase:
		attrs["engine"] = schema.StringAttribute{
			Optional:    true,
			Description: "Optional open SQL engine capability token. Defaults to sqlite; the selected Target implementation must advertise it.",
			Validators:  []validator.String{StringToken()},
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
		attrs["connections"] = resourceConnectionAttribute()
	case specVectorIndex:
		attrs["dimensions"] = schema.Int64Attribute{
			Required:    true,
			Description: "Positive vector dimensions fixed for the index lifecycle.",
		}
		attrs["metric"] = schema.StringAttribute{
			Optional:    true,
			Description: "Open similarity metric capability token. Defaults to cosine and requires explicit Target support.",
			Validators:  []validator.String{StringToken()},
		}
		attrs["connections"] = resourceConnectionAttribute()
	case specDurableWorkflow:
		attrs["artifact_path"] = schema.StringAttribute{
			Optional:    true,
			Description: "OpenTofu-runner-local path to a prebuilt workflow artifact.",
		}
		attrs["artifact_url"] = schema.StringAttribute{
			Optional:    true,
			Description: "HTTPS URL to an immutable workflow artifact. Requires artifact_sha256.",
		}
		attrs["artifact_ref"] = schema.StringAttribute{
			Optional:    true,
			Description: "Host-allocated opaque immutable artifact reference. Requires artifact_sha256.",
		}
		attrs["artifact_sha256"] = schema.StringAttribute{
			Optional:    true,
			Description: "Expected artifact SHA-256 digest for artifact_url or artifact_ref.",
		}
		attrs["entrypoint"] = schema.StringAttribute{
			Required:    true,
			Description: "Workflow runtime entrypoint.",
		}
		attrs["max_attempts"] = schema.Int64Attribute{
			Optional:    true,
			Description: "Optional positive maximum workflow attempts.",
		}
		attrs["initial_backoff_seconds"] = schema.Int64Attribute{
			Optional:    true,
			Description: "Optional non-negative initial retry backoff in seconds.",
		}
		attrs["connections"] = resourceConnectionAttribute()
	case specStatefulActorNamespace:
		attrs["class_name"] = schema.StringAttribute{
			Required:    true,
			Description: "Runtime class identifier owning actor behavior inside this namespace.",
		}
		attrs["storage_profile"] = schema.StringAttribute{
			Optional:    true,
			Description: "Open namespace storage capability token. Defaults to durable_sqlite.",
			Validators:  []validator.String{StringToken()},
		}
		attrs["migration_tag"] = schema.StringAttribute{
			Optional:    true,
			Description: "Optional namespace migration tag; this never identifies an actor instance.",
		}
		attrs["connections"] = resourceConnectionAttribute()
	case specSchedule:
		attrs["cron"] = schema.StringAttribute{
			Required:    true,
			Description: "Portable five-field cron expression.",
		}
		attrs["timezone"] = schema.StringAttribute{
			Optional:    true,
			Description: "Open timezone token. Defaults to UTC; non-UTC requires explicit Resolver capability evidence.",
			Validators:  []validator.String{StringToken()},
		}
		attrs["connections"] = requiredResourceConnectionAttribute()
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
	res, err := r.data.client.ObserveResource(ctx, r.cfg.kind, state.Name.ValueString(), readSpace)
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
	r.data.resourceShapeMutate.Lock()
	defer r.data.resourceShapeMutate.Unlock()
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
	case specSQLDatabase:
		var m sqlDatabaseModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specContainerService:
		var m containerServiceModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specVectorIndex:
		var m vectorIndexModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specDurableWorkflow:
		var m durableWorkflowModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specStatefulActorNamespace:
		var m statefulActorNamespaceModel
		diags := plan.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specSchedule:
		var m scheduleModel
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
	case specSQLDatabase:
		var m sqlDatabaseModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specContainerService:
		var m containerServiceModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specVectorIndex:
		var m vectorIndexModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specDurableWorkflow:
		var m durableWorkflowModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specStatefulActorNamespace:
		var m statefulActorNamespaceModel
		diags := state.Get(ctx, &m)
		return m.toServiceShapeModel(), diags
	case specSchedule:
		var m scheduleModel
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
	case specSQLDatabase:
		return state.Set(ctx, sqlDatabaseModelFromServiceShape(m))
	case specContainerService:
		return state.Set(ctx, containerServiceModelFromServiceShape(m))
	case specVectorIndex:
		return state.Set(ctx, vectorIndexModelFromServiceShape(m))
	case specDurableWorkflow:
		return state.Set(ctx, durableWorkflowModelFromServiceShape(m))
	case specStatefulActorNamespace:
		return state.Set(ctx, statefulActorNamespaceModelFromServiceShape(m))
	case specSchedule:
		return state.Set(ctx, scheduleModelFromServiceShape(m))
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
	r.data.resourceShapeMutate.Lock()
	defer r.data.resourceShapeMutate.Unlock()
	res, err := r.data.client.PutResource(ctx, r.cfg.kind, plan.Name.ValueString(), body)
	if err != nil {
		diags.AddError("Failed to apply "+r.cfg.kind, err.Error())
		return
	}
	plan.Space = types.StringValue(space)
	// OpenTofu represents an omitted Optional+Computed field as unknown during
	// create. Materialize the wire default only after a successful apply so new
	// state is known, while historical state can remain null during refresh-free
	// planning and therefore stays no-op compatible with the pre-field schema.
	if r.cfg.spec == specObjectBucket &&
		(plan.StorageClass.IsNull() || plan.StorageClass.IsUnknown() || plan.StorageClass.ValueString() == "") {
		plan.StorageClass = types.StringValue("standard")
	}
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
		storageClass := "standard"
		if !m.StorageClass.IsNull() && !m.StorageClass.IsUnknown() && m.StorageClass.ValueString() != "" {
			storageClass = m.StorageClass.ValueString()
		}
		if storageClass != "standard" && storageClass != "infrequent_access" {
			diags.AddAttributeError(
				path.Root("storage_class"),
				"Invalid storage class",
				"ObjectBucket storage_class must be standard or infrequent_access.",
			)
			return nil, "", diags
		}
		spec["storageClass"] = storageClass
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
		if connections := resourceConnectionsToSpec(ctx, m.Connections, &diags); len(connections) > 0 {
			spec["connections"] = connections
		}
	case specVectorIndex:
		if m.Dimensions.IsNull() || m.Dimensions.IsUnknown() || m.Dimensions.ValueInt64() <= 0 {
			diags.AddAttributeError(path.Root("dimensions"), "Invalid vector dimensions", "dimensions must be a positive integer.")
			return nil, "", diags
		}
		spec["dimensions"] = m.Dimensions.ValueInt64()
		if metric := knownTrimmedString(m.Metric); metric != "" {
			spec["metric"] = metric
		}
		if connections := resourceConnectionsToSpec(ctx, m.Connections, &diags); len(connections) > 0 {
			spec["connections"] = connections
		}
	case specDurableWorkflow:
		source, sourceDiags := (artifactSourceValues{
			Path: m.ArtifactPath, URL: m.ArtifactURL,
			Ref: m.ArtifactRef, SHA256: m.ArtifactSHA256,
		}).toSpec("DurableWorkflow")
		diags.Append(sourceDiags...)
		if diags.HasError() {
			return nil, "", diags
		}
		entrypoint := m.Entrypoint.ValueString()
		if m.Entrypoint.IsNull() || m.Entrypoint.IsUnknown() || !printableBoundedString(entrypoint, 256) {
			diags.AddAttributeError(path.Root("entrypoint"), "Invalid workflow entrypoint", "entrypoint must be a non-empty printable string of at most 256 characters.")
			return nil, "", diags
		}
		spec["source"] = source
		spec["entrypoint"] = knownTrimmedString(m.Entrypoint)
		retry := map[string]any{}
		if !m.MaxAttempts.IsNull() && !m.MaxAttempts.IsUnknown() {
			if m.MaxAttempts.ValueInt64() < 1 {
				diags.AddAttributeError(path.Root("max_attempts"), "Invalid workflow retry limit", "max_attempts must be a positive integer.")
				return nil, "", diags
			}
			retry["maxAttempts"] = m.MaxAttempts.ValueInt64()
		}
		if !m.InitialBackoffSeconds.IsNull() && !m.InitialBackoffSeconds.IsUnknown() {
			if m.InitialBackoffSeconds.ValueInt64() < 0 {
				diags.AddAttributeError(path.Root("initial_backoff_seconds"), "Invalid workflow retry backoff", "initial_backoff_seconds must be a non-negative integer.")
				return nil, "", diags
			}
			retry["initialBackoffSeconds"] = m.InitialBackoffSeconds.ValueInt64()
		}
		if len(retry) > 0 {
			spec["retry"] = retry
		}
		if connections := resourceConnectionsToSpec(ctx, m.Connections, &diags); len(connections) > 0 {
			spec["connections"] = connections
		}
	case specStatefulActorNamespace:
		className := m.ClassName.ValueString()
		if m.ClassName.IsNull() || m.ClassName.IsUnknown() || !validRuntimeClassName(className) {
			diags.AddAttributeError(path.Root("class_name"), "Invalid actor class name", "class_name must be a valid runtime class identifier.")
			return nil, "", diags
		}
		spec["className"] = className
		if storageProfile := knownTrimmedString(m.StorageProfile); storageProfile != "" {
			spec["storageProfile"] = storageProfile
		}
		if migrationTag := m.MigrationTag.ValueString(); !m.MigrationTag.IsNull() && !m.MigrationTag.IsUnknown() {
			if !printableBoundedString(migrationTag, 128) {
				diags.AddAttributeError(path.Root("migration_tag"), "Invalid namespace migration tag", "migration_tag must be a non-empty printable string of at most 128 characters.")
				return nil, "", diags
			}
			spec["migrationTag"] = knownTrimmedString(m.MigrationTag)
		}
		if connections := resourceConnectionsToSpec(ctx, m.Connections, &diags); len(connections) > 0 {
			spec["connections"] = connections
		}
	case specSchedule:
		cron, ok := normalizedPortableCron(m.Cron.ValueString())
		if m.Cron.IsNull() || m.Cron.IsUnknown() || !ok {
			diags.AddAttributeError(path.Root("cron"), "Invalid schedule cron", "cron must be a portable five-field expression using numbers, *, comma, range, or step syntax.")
			return nil, "", diags
		}
		spec["cron"] = cron
		if timezone := knownTrimmedString(m.Timezone); timezone != "" {
			spec["timezone"] = timezone
		}
		if m.Connections.IsNull() || m.Connections.IsUnknown() || len(m.Connections.Elements()) != 1 {
			diags.AddAttributeError(path.Root("connections"), "Invalid schedule target", "connections must contain exactly one schedule target.")
			return nil, "", diags
		}
		connections := resourceConnectionsToSpec(ctx, m.Connections, &diags)
		if diags.HasError() {
			return nil, "", diags
		}
		if len(connections) != 1 {
			diags.AddAttributeError(path.Root("connections"), "Invalid schedule target", "connections must contain exactly one schedule target.")
			return nil, "", diags
		}
		for _, raw := range connections {
			connection, ok := raw.(map[string]any)
			if !ok || connection["projection"] != "schedule_trigger" || !stringSliceContains(connection["permissions"], "invoke") {
				diags.AddAttributeError(path.Root("connections"), "Invalid schedule target", "the schedule target must use schedule_trigger projection and include invoke permission.")
				return nil, "", diags
			}
		}
		spec["connections"] = connections
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
		if v, ok := res.Spec["storageClass"].(string); ok && v != "" {
			m.StorageClass = types.StringValue(v)
		} else {
			m.StorageClass = types.StringValue("standard")
		}
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
		if raw, ok := res.Spec["connections"]; ok {
			connections, d := resourceConnectionsFromSpec(ctx, raw)
			diags.Append(d...)
			m.Connections = connections
		} else {
			m.Connections = types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes})
		}
	case specVectorIndex:
		m.Dimensions = int64FromSpec(res.Spec["dimensions"])
		m.Metric = optionalStringFromAny(res.Spec["metric"])
		m.Connections = refreshResourceConnections(ctx, res.Spec["connections"], &diags)
	case specDurableWorkflow:
		source := artifactSourceValuesFromSpec(res.Spec["source"])
		m.ArtifactPath = source.Path
		m.ArtifactURL = source.URL
		m.ArtifactRef = source.Ref
		m.ArtifactSHA256 = source.SHA256
		m.Entrypoint = optionalStringFromAny(res.Spec["entrypoint"])
		if raw, ok := res.Spec["retry"].(map[string]any); ok {
			m.MaxAttempts = int64FromSpec(raw["maxAttempts"])
			m.InitialBackoffSeconds = int64FromSpec(raw["initialBackoffSeconds"])
		} else {
			m.MaxAttempts = types.Int64Null()
			m.InitialBackoffSeconds = types.Int64Null()
		}
		m.Connections = refreshResourceConnections(ctx, res.Spec["connections"], &diags)
	case specStatefulActorNamespace:
		m.ClassName = optionalStringFromAny(res.Spec["className"])
		m.StorageProfile = optionalStringFromAny(res.Spec["storageProfile"])
		m.MigrationTag = optionalStringFromAny(res.Spec["migrationTag"])
		m.Connections = refreshResourceConnections(ctx, res.Spec["connections"], &diags)
	case specSchedule:
		m.Cron = optionalStringFromAny(res.Spec["cron"])
		m.Timezone = optionalStringFromAny(res.Spec["timezone"])
		m.Connections = refreshResourceConnections(ctx, res.Spec["connections"], &diags)
	}
	return diags
}

func refreshResourceConnections(ctx context.Context, raw any, diags *diag.Diagnostics) types.List {
	if raw == nil {
		return types.ListNull(types.ObjectType{AttrTypes: resourceConnectionAttrTypes})
	}
	connections, d := resourceConnectionsFromSpec(ctx, raw)
	diags.Append(d...)
	return connections
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
