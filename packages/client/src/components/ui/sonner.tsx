import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useThemePreference } from "@/lib/theme";

function Toaster(props: ToasterProps) {
  const theme = useThemePreference();
  return <Sonner theme={theme} className="toaster group" {...props} />;
}

export { Toaster };
