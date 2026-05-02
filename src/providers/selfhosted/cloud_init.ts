/**
 * Minimal cloud-init template renderer for the self-hosted VM materializer.
 *
 * The renderer accepts a desired-state-style spec and emits a single
 * `#cloud-config` document describing:
 *
 *   - operator-managed packages to install (e.g. `podman`, `caddy`)
 *   - tenant-managed systemd units (one per workload)
 *   - tenant-managed `write_files` entries for env files / Caddyfile
 *   - a `runcmd` block that enables the units in dependency order
 *
 * It does not talk to any cloud API. Operators feed the rendered string into
 * their VM provisioner of choice (cloud-init userdata, Terraform, AWS EC2
 * `user_data`, GCP `startup-script`, Hetzner Cloud, etc.).
 */

export interface CloudInitWriteFile {
  readonly path: string;
  readonly content: string;
  readonly owner?: string;
  readonly permissions?: string;
}

export interface CloudInitSystemdUnit {
  readonly name: string;
  /** Body of the `[Unit]/[Service]/[Install]` ini sections. */
  readonly contents: string;
  readonly enable?: boolean;
  readonly start?: boolean;
}

export interface CloudInitSpec {
  readonly hostname?: string;
  readonly packages?: readonly string[];
  readonly users?: readonly CloudInitUser[];
  readonly writeFiles?: readonly CloudInitWriteFile[];
  readonly systemdUnits?: readonly CloudInitSystemdUnit[];
  readonly runCmd?: readonly string[];
  readonly bootCmd?: readonly string[];
  readonly finalMessage?: string;
}

export interface CloudInitUser {
  readonly name: string;
  readonly groups?: readonly string[];
  readonly sudo?: string;
  readonly shell?: string;
  readonly sshAuthorizedKeys?: readonly string[];
}

export function renderCloudInit(spec: CloudInitSpec): string {
  const lines: string[] = ["#cloud-config"];
  if (spec.hostname) lines.push(`hostname: ${yamlScalar(spec.hostname)}`);
  if (spec.packages && spec.packages.length > 0) {
    lines.push("packages:");
    for (const pkg of spec.packages) lines.push(`  - ${yamlScalar(pkg)}`);
  }
  if (spec.users && spec.users.length > 0) {
    lines.push("users:");
    for (const user of spec.users) {
      lines.push(`  - name: ${yamlScalar(user.name)}`);
      if (user.groups && user.groups.length > 0) {
        lines.push(`    groups: [${user.groups.map(yamlScalar).join(", ")}]`);
      }
      if (user.sudo) lines.push(`    sudo: ${yamlScalar(user.sudo)}`);
      if (user.shell) lines.push(`    shell: ${yamlScalar(user.shell)}`);
      if (user.sshAuthorizedKeys && user.sshAuthorizedKeys.length > 0) {
        lines.push("    ssh_authorized_keys:");
        for (const key of user.sshAuthorizedKeys) {
          lines.push(`      - ${yamlScalar(key)}`);
        }
      }
    }
  }
  if (spec.writeFiles && spec.writeFiles.length > 0) {
    lines.push("write_files:");
    for (const file of spec.writeFiles) {
      lines.push(`  - path: ${yamlScalar(file.path)}`);
      if (file.owner) lines.push(`    owner: ${yamlScalar(file.owner)}`);
      if (file.permissions) {
        lines.push(`    permissions: '${file.permissions}'`);
      }
      lines.push("    content: |");
      for (const contentLine of file.content.split("\n")) {
        lines.push(`      ${contentLine}`);
      }
    }
  }
  if (spec.systemdUnits && spec.systemdUnits.length > 0) {
    if (!spec.writeFiles || spec.writeFiles.length === 0) {
      lines.push("write_files:");
    }
    for (const unit of spec.systemdUnits) {
      lines.push(`  - path: /etc/systemd/system/${yamlPath(unit.name)}`);
      lines.push("    permissions: '0644'");
      lines.push("    content: |");
      for (const unitLine of unit.contents.split("\n")) {
        lines.push(`      ${unitLine}`);
      }
    }
  }
  const runcmd = collectRuncmd(spec);
  if (runcmd.length > 0) {
    lines.push("runcmd:");
    for (const cmd of runcmd) lines.push(`  - ${yamlScalar(cmd)}`);
  }
  if (spec.bootCmd && spec.bootCmd.length > 0) {
    lines.push("bootcmd:");
    for (const cmd of spec.bootCmd) lines.push(`  - ${yamlScalar(cmd)}`);
  }
  if (spec.finalMessage) {
    lines.push(`final_message: ${yamlScalar(spec.finalMessage)}`);
  }
  return lines.join("\n") + "\n";
}

function collectRuncmd(spec: CloudInitSpec): readonly string[] {
  const cmds: string[] = [];
  if (spec.systemdUnits) {
    cmds.push("systemctl daemon-reload");
    for (const unit of spec.systemdUnits) {
      if (unit.enable !== false) {
        cmds.push(`systemctl enable ${escapeShell(unit.name)}`);
      }
      if (unit.start !== false) {
        cmds.push(`systemctl start ${escapeShell(unit.name)}`);
      }
    }
  }
  for (const cmd of spec.runCmd ?? []) cmds.push(cmd);
  return cmds;
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./@:+-]+$/.test(value) && !/^[0-9]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlPath(value: string): string {
  return yamlScalar(value);
}

function escapeShell(value: string): string {
  if (/^[A-Za-z0-9_./@:+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
