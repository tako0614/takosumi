// Package provider implements the thin Takosumi OpenTofu/Terraform provider.
//
// The provider is intentionally thin: it carries an HCL schema, validation, a
// Takosumi Resource Shape API HTTP client, and preview/apply/status mapping.
// It does not call AWS / Cloudflare / Kubernetes SDKs, does not select a
// backend, and does not manage credentials. Backend selection happens
// server-side in the Takosumi Resolver. The provider is capability-driven: on
// configure it discovers server capabilities and never branches on an edition
// string.
package provider

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

// Environment variable fallbacks for provider configuration.
const (
	envEndpoint = "TAKOSUMI_ENDPOINT"
	envSpace    = "TAKOSUMI_SPACE"
	envToken    = "TAKOSUMI_TOKEN"
)

// Ensure takosumiProvider satisfies the provider.Provider interface.
var _ provider.Provider = (*takosumiProvider)(nil)

// takosumiProvider is the provider implementation.
type takosumiProvider struct {
	// version is set at build time and surfaced to Terraform.
	version string
}

// providerData is shared with every resource via Configure.
type providerData struct {
	client       *client.Client
	defaultSpace string
	capabilities client.ProductCapabilities
}

// takosumiProviderModel maps the provider configuration schema.
type takosumiProviderModel struct {
	Endpoint types.String `tfsdk:"endpoint"`
	Space    types.String `tfsdk:"space"`
	Token    types.String `tfsdk:"token"`
}

// New returns a provider factory bound to a build version.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &takosumiProvider{version: version}
	}
}

func (p *takosumiProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "takosumi"
	resp.Version = p.version
}

func (p *takosumiProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The Takosumi provider resolves Takosumi Resource Shapes (e.g. ObjectBucket) " +
			"through a Takosumi control plane. It is a thin client over the Resource Shape API; " +
			"the server-side Resolver selects the backend implementation.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{
				Optional: true,
				Description: "Takosumi origin, e.g. https://takosumi.example.com. " +
					"May also be set via the " + envEndpoint + " environment variable.",
			},
			"space": schema.StringAttribute{
				Optional: true,
				Description: "Default Space for resources that do not set their own. " +
					"May also be set via the " + envSpace + " environment variable.",
			},
			"token": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				Description: "Bearer token sent as `Authorization: Bearer <token>`. " +
					"May also be set via the " + envToken + " environment variable.",
			},
		},
	}
}

func (p *takosumiProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg takosumiProviderModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if cfg.Endpoint.IsUnknown() {
		resp.Diagnostics.AddAttributeError(
			path.Root("endpoint"),
			"Unknown Takosumi endpoint",
			"The endpoint cannot be determined at configuration time. Set it to a static value "+
				"or via the "+envEndpoint+" environment variable.",
		)
		return
	}

	endpoint := firstNonEmpty(cfg.Endpoint.ValueString(), os.Getenv(envEndpoint))
	if endpoint == "" {
		resp.Diagnostics.AddAttributeError(
			path.Root("endpoint"),
			"Missing Takosumi endpoint",
			"Set the provider `endpoint` attribute or the "+envEndpoint+" environment variable.",
		)
		return
	}

	token := firstNonEmpty(cfg.Token.ValueString(), os.Getenv(envToken))
	space := firstNonEmpty(cfg.Space.ValueString(), os.Getenv(envSpace))

	httpClient := &http.Client{Timeout: 30 * time.Second}

	c, err := configureClient(ctx, endpoint, token, httpClient)
	if err != nil {
		resp.Diagnostics.AddError("Takosumi configuration failed", err.Error())
		return
	}

	data := &providerData{
		client:       c,
		defaultSpace: space,
		capabilities: c.Capabilities,
	}
	resp.ResourceData = data
	resp.DataSourceData = data
}

func (p *takosumiProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewObjectBucketResource,
		NewEdgeWorkerResource,
		NewAIEndpointResource,
		NewTargetPoolResource,
	}
}

func (p *takosumiProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return nil
}

// configureClient builds the client, discovers capabilities, and enforces the
// Resource Shape API gate. It is split out from Configure so it can be unit
// tested against an httptest server without driving the full framework.
func configureClient(ctx context.Context, endpoint, token string, httpClient *http.Client) (*client.Client, error) {
	c := client.New(endpoint, token, httpClient)

	disco, err := c.Discover(ctx)
	if err != nil {
		return nil, fmt.Errorf("discovering Takosumi endpoint %q: %w", endpoint, err)
	}

	if !disco.SupportsResourceShapes() {
		return nil, fmt.Errorf(
			"this Takosumi endpoint does not expose the Resource Shape API "+
				"(features.resource_shapes is not true at %s/.well-known/takosumi)",
			c.Endpoint(),
		)
	}
	if !supportsAPIVersion(disco.APIVersions, client.APIVersion) {
		return nil, fmt.Errorf(
			"this Takosumi endpoint does not advertise API version %s (api_versions=%v)",
			client.APIVersion,
			disco.APIVersions,
		)
	}
	caps, err := c.GetCapabilities(ctx)
	if err != nil {
		return nil, fmt.Errorf("loading Takosumi capabilities from %q: %w", endpoint, err)
	}
	if caps.APIVersion != client.APIVersion {
		return nil, fmt.Errorf(
			"this Takosumi endpoint returned unsupported capabilities apiVersion %q (expected %q)",
			caps.APIVersion,
			client.APIVersion,
		)
	}

	return c, nil
}

func supportsAPIVersion(versions []string, want string) bool {
	for _, version := range versions {
		if version == want {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
