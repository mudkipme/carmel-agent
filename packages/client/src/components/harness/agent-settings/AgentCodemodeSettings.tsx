import { Trans } from "@lingui/react/macro";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

export function AgentCodemodeSettings({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <FieldGroup>
        <Field>
          <Field orientation="horizontal">
            <Switch id="agent-codemode" checked={enabled} onCheckedChange={onChange} />
            <FieldLabel htmlFor="agent-codemode">
              <Trans>Enable codemode</Trans>
            </FieldLabel>
          </Field>
          <FieldDescription>
            <Trans>
              Uses this agent's permitted workspace, shell, network, MCP, and session tools.
              Existing permissions and MCP tool allowlists still apply.
            </Trans>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </section>
  );
}
