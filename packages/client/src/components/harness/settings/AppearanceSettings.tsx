import { Trans } from "@lingui/react/macro";
import { LanguagePicker } from "@/components/harness/settings/LanguagePicker";
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
      <LanguagePicker />
      <Field>
        <FieldLabel htmlFor="appearance-theme">
          <Trans>Theme</Trans>
        </FieldLabel>
        <Select value={value} onValueChange={(nextValue) => onChange(nextValue as ThemePreference)}>
          <SelectTrigger id="appearance-theme" className="w-full sm:max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="system">
                <Trans>System</Trans>
              </SelectItem>
              <SelectItem value="light">
                <Trans>Light</Trans>
              </SelectItem>
              <SelectItem value="dark">
                <Trans>Dark</Trans>
              </SelectItem>
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
        <Trans>Save appearance</Trans>
      </Button>
    </div>
  );
}
