import { useLingui } from "@lingui/react";
import { ToggleRow } from "@/components/harness/form-primitives";
import type { AgentPermissions } from "@carmel-agent/shared";

const configurablePermissions: Array<keyof AgentPermissions> = [
  "read",
  "write",
  "edit",
  "bash",
  "network",
];

const permissionLabels = {
  read: /*i18n*/ "Read files",
  write: /*i18n*/ "Write files",
  edit: /*i18n*/ "Edit files",
  bash: /*i18n*/ "Run commands",
  network: /*i18n*/ "Network access",
} as const;

export function AgentPermissionsSettings({
  permissions,
  onChange,
}: {
  permissions: AgentPermissions;
  onChange: (permissions: AgentPermissions) => void;
}) {
  const { i18n } = useLingui();
  return (
    <section className="grid gap-4">
      <div className="grid gap-2">
        {configurablePermissions.map((permission) => (
          <ToggleRow
            key={permission}
            label={i18n._(permissionLabels[permission])}
            checked={permissions[permission]}
            onCheckedChange={(checked) => onChange({ ...permissions, [permission]: checked })}
          />
        ))}
      </div>
    </section>
  );
}
