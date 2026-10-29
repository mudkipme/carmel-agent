import { StrictMode } from "react";
import { I18nProvider } from "@lingui/react";
import { i18n } from "@/lib/i18n";
import { createRoot } from "react-dom/client";
import App from "@/App";
import "@/index.css";
import { applyThemePreference } from "@/lib/theme";
import { watchOnScreenKeyboard } from "@/lib/viewport";
import { Toaster } from "@/components/ui/sonner";
import { ActionDialogs } from "@/components/harness/ActionDialogs";

applyThemePreference();
watchOnScreenKeyboard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <App />
      <ActionDialogs />
      <Toaster />
    </I18nProvider>
  </StrictMode>,
);
