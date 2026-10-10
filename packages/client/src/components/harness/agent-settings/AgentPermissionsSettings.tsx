import { SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import type { AgentPermissions } from "@carmel-agent/shared";

const configurablePermissions: Array<keyof AgentPermissions> = [
  "read",
  "write",
  "edit",
  "bash",
  "network",
];

const permissionLabels = {
  read: "Read files",
  write: "Write files",
  edit: "Edit files",
  bash: "Run commands",
  network: "Network access",
} as const;

export function AgentPermissionsSettings({
  permissions,
  onChange,
}: {
  permissions: AgentPermissions;
  onChange: (permissions: AgentPermissions) => void;
}) {
  return (
    <section className="grid gap-4">
      <SectionHeader title="Permissions" />
      <div className="grid gap-2">
        {configurablePermissions.map((permission) => (
          <ToggleRow
            key={permission}
            label={permissionLabels[permission]}
            checked={permissions[permission]}
            onCheckedChange={(checked) => onChange({ ...permissions, [permission]: checked })}
          />
        ))}
      </div>
    </section>
  );
}
