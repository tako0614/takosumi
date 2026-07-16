package provider

import (
	"context"
	"errors"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/takosjp/terraform-provider-takosumi/internal/client"
)

var (
	_ datasource.DataSource              = (*interfaceDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*interfaceDataSource)(nil)
)

type interfaceDataSource struct {
	data *providerData
}

func NewInterfaceDataSource() datasource.DataSource {
	return &interfaceDataSource{}
}

type interfaceDataSourceModel struct {
	ID               types.String `tfsdk:"id"`
	Name             types.String `tfsdk:"name"`
	OwnerID          types.String `tfsdk:"owner_id"`
	Type             types.String `tfsdk:"type"`
	Version          types.String `tfsdk:"version"`
	DocumentJSON     types.String `tfsdk:"document_json"`
	ResolvedInputs   types.Map    `tfsdk:"resolved_inputs"`
	Phase            types.String `tfsdk:"phase"`
	ResolvedRevision types.Int64  `tfsdk:"resolved_revision"`
}

func (d *interfaceDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_interface"
}

func (d *interfaceDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Reads one Takosumi `Interface` by `id`, or by `name` within the ambient Workspace " +
			"(`" + envWorkspaceID + "`, injected by the Takosumi runner during a Run). It exposes the declared " +
			"document and the resolved public inputs; it never reads or manages `InterfaceBinding` authorization.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Interface id. Set either id, or name.",
			},
			"name": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Interface name, looked up in the ambient Workspace (" + envWorkspaceID + ").",
			},
			"owner_id": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Optional owner id filter for name lookups; also exposes the resolved owner id.",
			},
			"type": schema.StringAttribute{
				Computed:    true,
				Description: "Interface type token, e.g. mcp.server.",
			},
			"version": schema.StringAttribute{
				Computed:    true,
				Description: "Interface type version.",
			},
			"document_json": schema.StringAttribute{
				Computed:    true,
				Description: "Interface document as a canonical JSON value string.",
			},
			"resolved_inputs": schema.MapAttribute{
				Computed:    true,
				ElementType: types.StringType,
				Description: "Resolved public inputs. Non-string values are JSON-encoded.",
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

func (d *interfaceDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
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
	d.data = data
}

func (d *interfaceDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	if d.data == nil || d.data.client == nil {
		resp.Diagnostics.AddError("Provider not configured", "Configure the Takosumi provider before using this data source.")
		return
	}
	var config interfaceDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	stringValue := func(v types.String) string {
		if v.IsNull() || v.IsUnknown() {
			return ""
		}
		return v.ValueString()
	}
	id := stringValue(config.ID)
	name := stringValue(config.Name)
	ownerID := stringValue(config.OwnerID)
	if id == "" && name == "" {
		resp.Diagnostics.AddError(
			"Missing Interface lookup key",
			"Set either id, or name (optionally with owner_id) to look up an Interface.",
		)
		return
	}
	if id != "" && name != "" {
		resp.Diagnostics.AddAttributeError(
			path.Root("name"),
			"Ambiguous Interface lookup",
			"Set either id or name, not both.",
		)
		return
	}

	var record *client.InterfaceRecord
	if id != "" {
		found, _, err := d.data.client.GetInterface(ctx, id)
		if err != nil {
			if errors.Is(err, client.ErrNotFound) {
				resp.Diagnostics.AddError("Interface not found", fmt.Sprintf("No Interface with id %q exists at this endpoint.", id))
				return
			}
			resp.Diagnostics.AddError("Failed to read Interface", err.Error())
			return
		}
		record = found
	} else {
		workspaceID, _ := ambientRunIdentity()
		if workspaceID == "" {
			resp.Diagnostics.AddError(
				"Missing ambient Takosumi Workspace",
				"Looking up an Interface by name requires the Workspace id from the ambient "+envWorkspaceID+
					" environment variable, which the Takosumi runner injects during a Run. Set the "+
					"data source id instead, or run this module as a Takosumi Capsule.",
			)
			return
		}
		records, err := d.data.client.ListInterfaces(ctx, client.InterfaceListFilter{
			WorkspaceID: workspaceID,
			OwnerID:     ownerID,
		})
		if err != nil {
			resp.Diagnostics.AddError("Failed to list Interfaces", err.Error())
			return
		}
		// GET /v1/interfaces has no name query parameter; match client-side.
		var matches []client.InterfaceRecord
		for _, candidate := range records {
			if candidate.Metadata.Name == name {
				matches = append(matches, candidate)
			}
		}
		switch len(matches) {
		case 0:
			resp.Diagnostics.AddError(
				"Interface not found",
				fmt.Sprintf("No Interface named %q exists in Workspace %q.", name, workspaceID),
			)
			return
		case 1:
			record = &matches[0]
		default:
			resp.Diagnostics.AddError(
				"Ambiguous Interface name",
				fmt.Sprintf("%d Interfaces named %q exist in Workspace %q. Set owner_id or id to disambiguate.", len(matches), name, workspaceID),
			)
			return
		}
	}

	state, d2 := interfaceDataSourceState(ctx, record)
	resp.Diagnostics.Append(d2...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func interfaceDataSourceState(ctx context.Context, record *client.InterfaceRecord) (interfaceDataSourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	state := interfaceDataSourceModel{
		ID:               types.StringValue(record.Metadata.ID),
		Name:             types.StringValue(record.Metadata.Name),
		OwnerID:          types.StringValue(record.Metadata.OwnerRef.ID),
		Type:             types.StringValue(record.Spec.Type),
		Version:          types.StringValue(record.Spec.Version),
		Phase:            types.StringValue(record.Status.Phase),
		ResolvedRevision: types.Int64Value(record.Status.ResolvedRevision),
	}
	document, err := canonicalJSONString(record.Spec.Document)
	if err != nil {
		diags.AddError("Failed to read Interface", fmt.Sprintf("re-encoding spec.document: %s", err))
		return state, diags
	}
	state.DocumentJSON = types.StringValue(document)
	resolved, d := types.MapValueFrom(ctx, types.StringType, outputsToStringMap(record.Status.ResolvedInputs))
	diags.Append(d...)
	state.ResolvedInputs = resolved
	return state, diags
}
