import { i18n } from "@lingui/core";
import { toast } from "sonner";

export function errorMessage(error: unknown, fallback = i18n._("Unexpected error")) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

export function showError(title: string, error: unknown) {
  toast.error(title, { description: errorMessage(error) });
}
