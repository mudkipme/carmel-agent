import {
  ArrowLeftIcon,
  DatabaseIcon,
  KeyRoundIcon,
  MonitorIcon,
  UserIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { AccountSettings } from "@/components/harness/settings/AccountSettings";
import { AppearanceSettings } from "@/components/harness/settings/AppearanceSettings";
import { ModelSettings } from "@/components/harness/settings/ModelSettings";
import { ProviderSettings } from "@/components/harness/settings/ProviderSettings";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import { type ModelRef, type OAuthProviderSummary } from "@carmel-agent/shared";

const settingsSections = [
  { id: "models", label: "Models", icon: DatabaseIcon },
  { id: "providers", label: "Providers", icon: KeyRoundIcon },
  { id: "appearance", label: "Appearance", icon: MonitorIcon },
  { id: "account", label: "Account", icon: UserIcon },
] as const;
type SettingsSection = (typeof settingsSections)[number]["id"];

export function SettingsPage() {
  const navigate = useNavigate();
  const { section } = useParams();
  const activeSection = settingsSections.some((item) => item.id === section)
    ? (section as SettingsSection)
    : "models";
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const providerConfigs = useHarnessStore((state) => state.providerConfigs);
  const activeUser = useHarnessStore((state) => state.users.find((item) => item.id === state.activeUserId));
  const upsertUser = useHarnessStore((state) => state.upsertUser);
  const upsertModelRef = useHarnessStore((state) => state.upsertModelRef);
  const themePreference = useThemePreference();
  const [draftThemePreference, setDraftThemePreference] = useState<ThemePreference>(() => themePreference);
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderSummary[]>([]);
  const [modelStatus, setModelStatus] = useState<{ tone: "muted" | "destructive"; message: string } | null>(null);
  const [updatingModelSettings, setUpdatingModelSettings] = useState(false);
  const [appearanceSaveMessage, setAppearanceSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (section && !settingsSections.some((item) => item.id === section)) {
      navigate("/settings/models", { replace: true });
    }
  }, [navigate, section]);

  useEffect(() => {
    void api.getOAuthProviders().then(setOAuthProviders).catch(() => setOAuthProviders([]));
  }, []);

  const updateFastTaskModel = async (modelRefId: string) => {
    if (!activeUser) return;
    setUpdatingModelSettings(true);
    setModelStatus({ tone: "muted", message: "Saving fast task model..." });
    try {
      await upsertUser({
        ...activeUser,
        fastTaskModelRefId: modelRefId || undefined,
      });
      setModelStatus({ tone: "muted", message: "Fast task model saved." });
    } catch (error) {
      setModelStatus({
        tone: "destructive",
        message: error instanceof Error ? error.message : "Unable to save fast task model",
      });
    } finally {
      setUpdatingModelSettings(false);
    }
  };

  const updateModelSharing = async (model: ModelRef) => {
    setUpdatingModelSettings(true);
    setModelStatus({ tone: "muted", message: "Saving model sharing..." });
    try {
      await upsertModelRef(model);
      setModelStatus({ tone: "muted", message: "Model sharing saved." });
    } catch (error) {
      setModelStatus({
        tone: "destructive",
        message: error instanceof Error ? error.message : "Unable to save model sharing",
      });
    } finally {
      setUpdatingModelSettings(false);
    }
  };

  const saveAppearanceSettings = () => {
    setThemePreference(draftThemePreference);
    setAppearanceSaveMessage("Appearance saved.");
  };

  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon-sm" title="Back to harness" onClick={() => navigate("/")}>
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">Harness Settings</h1>
            <p className="truncate text-xs text-muted-foreground">Manage global provider and model settings.</p>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b bg-muted/35 p-2 md:w-56 md:border-r md:border-b-0">
          <nav className="grid grid-cols-2 gap-1 md:grid-cols-1">
            {settingsSections.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={`/settings/${item.id}`}
                  className={({ isActive }) =>
                    cn(
                      "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                      isActive && "bg-accent text-accent-foreground",
                    )
                  }
                >
                  <Icon data-icon="inline-start" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
        </aside>
        <section className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-6">
            {activeSection === "models" ? (
              <ModelSettings
                modelRefs={modelRefs}
                providerConfigs={providerConfigs}
                fastTaskModelRefId={activeUser?.fastTaskModelRefId ?? ""}
                onFastTaskModelChange={(modelRefId) => void updateFastTaskModel(modelRefId)}
                onModelChange={(model) => void updateModelSharing(model)}
                updating={updatingModelSettings}
                status={modelStatus}
              />
            ) : null}
            {activeSection === "providers" ? (
              <ProviderSettings
                providerConfigs={providerConfigs}
                modelRefs={modelRefs}
                oauthProviders={oauthProviders}
              />
            ) : null}
            {activeSection === "appearance" ? (
              <AppearanceSettings
                value={draftThemePreference}
                onChange={(nextValue) => {
                  setDraftThemePreference(nextValue);
                  setAppearanceSaveMessage(null);
                }}
                onSave={saveAppearanceSettings}
                saveMessage={appearanceSaveMessage}
              />
            ) : null}
            {activeSection === "account" ? (
              <AccountSettings />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
