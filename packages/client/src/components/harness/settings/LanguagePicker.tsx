import { useLingui } from "@lingui/react";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setLanguagePreference, useLanguagePreference } from "@/lib/i18n";
import { isLanguagePreference } from "@/lib/locale";
import { useId } from "react";

export function LanguagePicker() {
  const { i18n } = useLingui();
  const preference = useLanguagePreference();
  const id = useId();

  return (
    <Field>
      <FieldLabel htmlFor={id}>{i18n._("Language")}</FieldLabel>
      <Select
        value={preference}
        onValueChange={(value) => {
          if (isLanguagePreference(value)) setLanguagePreference(value);
        }}
      >
        <SelectTrigger id={id} className="w-full sm:max-w-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="system">{i18n._("System")}</SelectItem>
            <SelectItem value="en" lang="en">
              English
            </SelectItem>
            <SelectItem value="zh-Hans" lang="zh-Hans">
              简体中文
            </SelectItem>
            <SelectItem value="zh-Hant" lang="zh-Hant">
              繁體中文
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
