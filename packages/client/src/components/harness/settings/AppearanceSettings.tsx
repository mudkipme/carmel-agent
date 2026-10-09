import { SectionHeader } from "@/components/harness/form-primitives";
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ThemePreference } from "@/lib/theme";

export function AppearanceSettings({
  value,
  onChange,
  onSave,
  saveMessage,
}: {
  value: ThemePreference;
  onChange: (themePreference: ThemePreference) => void;
  onSave: () => void;
  saveMessage: string | null;
}) {
  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Appearance"
        description="Choose how Carmel Agent follows your display theme."
      />
      <Field>
        <FieldLabel>Theme</FieldLabel>
        <Select value={value} onValueChange={(nextValue) => onChange(nextValue as ThemePreference)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {saveMessage ? <p className="text-sm text-muted-foreground">{saveMessage}</p> : null}
      <Button type="button" onClick={onSave}>
        Save appearance
      </Button>
    </div>
  );
}
