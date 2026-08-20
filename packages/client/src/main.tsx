import { StrictMode } from "react";
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
    <App />
    <ActionDialogs />
    <Toaster />
  </StrictMode>,
);
