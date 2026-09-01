import { SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import type { AgentPermissions } from "@carmel-agent/shared";

const configurablePermissions: Array<keyof AgentPermissions> = ["read", "write", "edit", "bash", "network"];

export function AgentPermissionsSettings({
  permissions,
  onChange,
}: {
  permissions: AgentPermissions;
  onChange: (permissions: AgentPermissions) => void;
}) {
  return (
    <section className="grid gap-4">
      <SectionHeader
        title="Permissions"
        description="Read, write, and edit are enabled by default inside the working directory."
      />
      <div className="grid gap-2">
        {configurablePermissions.map((permission) => (
          <ToggleRow
            key={permission}
            label={permission}
            checked={permissions[permission]}
            onCheckedChange={(checked) => onChange({ ...permissions, [permission]: checked })}
          />
        ))}
      </div>
    </section>
  );
}
