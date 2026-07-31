import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid gap-1">
      <h3 className="text-sm leading-none font-medium">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <Label className="capitalize">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
