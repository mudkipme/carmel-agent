import {
  ArrowLeftIcon,
  DatabaseIcon,
  KeyRoundIcon,
  MonitorIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { AccountSettings } from "@/components/harness/settings/AccountSettings";
import { AppearanceSettings } from "@/components/harness/settings/AppearanceSettings";
import { ModelSettings } from "@/components/harness/settings/ModelSettings";
import { ProviderSettings } from "@/components/harness/settings/ProviderSettings";
import { UserSettings } from "@/components/harness/settings/UserSettings";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import { type ModelRef, type OAuthProviderSummary } from "@carmel-agent/shared";
import { errorMessage } from "@/lib/errors";

const allSettingsSections = [
  { id: "models", label: "Models", icon: DatabaseIcon, adminOnly: false },
  { id: "providers", label: "Providers", icon: KeyRoundIcon, adminOnly: true },
  { id: "appearance", label: "Appearance", icon: MonitorIcon, adminOnly: false },
  { id: "users", label: "Users", icon: UsersIcon, adminOnly: true },
  { id: "account", label: "Account", icon: UserIcon, adminOnly: false },
] as const;
type SettingsSection = (typeof allSettingsSections)[number]["id"];

export function SettingsPage() {
  const navigate = useNavigate();
  const { section } = useParams();
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const providerConfigs = useHarnessStore((state) => state.providerConfigs);
  const activeUser = useHarnessStore((state) => state.users.find((item) => item.id === state.activeUserId));
  const isAdmin = activeUser?.role === "admin";
  const settingsSections = allSettingsSections.filter((item) => !item.adminOnly || isAdmin);
  const activeSection = settingsSections.some((item) => item.id === section)
    ? (section as SettingsSection)
    : "models";
  const upsertUser = useHarnessStore((state) => state.upsertUser);
  const upsertModelRef = useHarnessStore((state) => state.upsertModelRef);
  const themePreference = useThemePreference();
  const [draftThemePreference, setDraftThemePreference] = useState<ThemePreference>(() => themePreference);
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderSummary[]>([]);
  const [modelStatus, setModelStatus] = useState<{ tone: "muted" | "destructive"; message: string } | null>(null);
  const [updatingModelSettings, setUpdatingModelSettings] = useState(false);
  const [appearanceSaveMessage, setAppearanceSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    const valid = allSettingsSections.some((item) => item.id === section && (!item.adminOnly || isAdmin));
    if (section && !valid) {
      navigate("/settings/models", { replace: true });
    }
  }, [navigate, section, isAdmin]);

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
        message: errorMessage(error, "Unable to save fast task model"),
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
        message: errorMessage(error, "Unable to save model sharing"),
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
    <main className="flex h-[100dvh] min-h-0 flex-col bg-background pr-[var(--safe-right)] pl-[var(--safe-left)] text-foreground">
      <header className="flex h-[calc(var(--header-height)+var(--safe-top))] shrink-0 items-center gap-3 border-b px-3 pt-[var(--safe-top)]">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon-sm" title="Back to harness" onClick={() => navigate("/")}>
            <ArrowLeftIcon />
          </Button>
          <h1 className="min-w-0 truncate text-sm font-medium">Harness Settings</h1>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b bg-sidebar p-2 md:w-56 md:border-r md:border-b-0">
          <nav className="grid grid-cols-2 gap-1 md:grid-cols-1">
            {settingsSections.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={`/settings/${item.id}`}
                  data-active={item.id === activeSection}
                  className={({ isActive }) =>
                    cn("nav-item flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px]", isActive && "font-medium")
                  }
                >
                  <Icon data-icon="inline-start" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
        </aside>
        <section className="min-w-0 min-h-0 flex-1 overflow-y-auto">
          <div
            data-settings-content
            className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 p-3 pb-[calc(0.75rem+var(--safe-bottom))] sm:p-4 sm:pb-[calc(1rem+var(--safe-bottom))] md:p-6 md:pb-[calc(1.5rem+var(--safe-bottom))]"
          >
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
            {activeSection === "users" ? <UserSettings /> : null}
            {activeSection === "account" ? (
              <AccountSettings />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
