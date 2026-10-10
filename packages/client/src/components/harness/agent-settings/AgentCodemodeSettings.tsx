import { SectionHeader } from "@/components/harness/form-primitives";
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
      <SectionHeader title="Codemode" description="Combine tool calls in JavaScript." />
      <FieldGroup>
        <Field>
          <Field orientation="horizontal">
            <Switch id="agent-codemode" checked={enabled} onCheckedChange={onChange} />
            <FieldLabel htmlFor="agent-codemode">Enable codemode</FieldLabel>
          </Field>
          <FieldDescription>
            Uses this agent's permitted workspace, shell, network, MCP, and session tools. Existing
            permissions and MCP tool allowlists still apply.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </section>
  );
}
