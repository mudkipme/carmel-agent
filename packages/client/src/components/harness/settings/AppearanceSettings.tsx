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
      <SectionHeader title="Appearance" />
      <Field>
        <FieldLabel htmlFor="appearance-theme">Theme</FieldLabel>
        <Select value={value} onValueChange={(nextValue) => onChange(nextValue as ThemePreference)}>
          <SelectTrigger id="appearance-theme" className="w-full sm:max-w-sm">
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
      {saveMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {saveMessage}
        </p>
      ) : null}
      <Button type="button" className="justify-self-start" onClick={onSave}>
        Save appearance
      </Button>
    </div>
  );
}
