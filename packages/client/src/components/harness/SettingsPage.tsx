import { useLingui } from "@lingui/react";
import {
  DatabaseIcon,
  KeySquareIcon,
  KeyRoundIcon,
  MonitorIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AccountSettings } from "@/components/harness/settings/AccountSettings";
import { ApiKeySettings } from "@/components/harness/settings/ApiKeySettings";
import { AppearanceSettings } from "@/components/harness/settings/AppearanceSettings";
import { ModelSettings } from "@/components/harness/settings/ModelSettings";
import { ProviderSettings } from "@/components/harness/settings/ProviderSettings";
import { UserSettings } from "@/components/harness/settings/UserSettings";
import { SettingsLayout } from "./SettingsLayout";
import { api } from "@/lib/api";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";
import { useHarnessStore } from "@/store/harness-store";
import { type ModelRef, type OAuthProviderSummary } from "@carmel-agent/shared";
import { errorMessage } from "@/lib/errors";

const allSettingsSections = [
  { id: "models", label: /*i18n*/ "Models", icon: DatabaseIcon, adminOnly: false },
  { id: "providers", label: /*i18n*/ "Providers", icon: KeyRoundIcon, adminOnly: true },
  { id: "api-keys", label: /*i18n*/ "API Keys", icon: KeySquareIcon, adminOnly: false },
  { id: "appearance", label: /*i18n*/ "Appearance", icon: MonitorIcon, adminOnly: false },
  { id: "users", label: /*i18n*/ "Users", icon: UsersIcon, adminOnly: true },
  { id: "account", label: /*i18n*/ "Account", icon: UserIcon, adminOnly: false },
] as const;
type SettingsSection = (typeof allSettingsSections)[number]["id"];

export function SettingsPage() {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const { section } = useParams();
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const providerConfigs = useHarnessStore((state) => state.providerConfigs);
  const activeUser = useHarnessStore((state) =>
    state.users.find((item) => item.id === state.activeUserId),
  );
  const isAdmin = activeUser?.role === "admin";
  const settingsSections = allSettingsSections.filter((item) => !item.adminOnly || isAdmin);
  const activeSection = settingsSections.some((item) => item.id === section)
    ? (section as SettingsSection)
    : "models";
  const upsertUser = useHarnessStore((state) => state.upsertUser);
  const upsertModelRef = useHarnessStore((state) => state.upsertModelRef);
  const themePreference = useThemePreference();
  const [draftThemePreference, setDraftThemePreference] = useState<ThemePreference>(
    () => themePreference,
  );
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderSummary[]>([]);
  const [modelStatus, setModelStatus] = useState<{
    tone: "muted" | "destructive";
    message: string;
  } | null>(null);
  const [updatingModelSettings, setUpdatingModelSettings] = useState(false);
  const [appearanceSaveMessage, setAppearanceSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    const valid = allSettingsSections.some(
      (item) => item.id === section && (!item.adminOnly || isAdmin),
    );
    if (section && !valid) {
      navigate("/settings/models", { replace: true });
    }
  }, [navigate, section, isAdmin]);

  useEffect(() => {
    void api
      .getOAuthProviders()
      .then(setOAuthProviders)
      .catch(() => setOAuthProviders([]));
  }, []);

  const updateFastTaskModel = async (modelRefId: string) => {
    if (!activeUser) return;
    setUpdatingModelSettings(true);
    setModelStatus({ tone: "muted", message: i18n._("Saving fast task model...") });
    try {
      await upsertUser({
        ...activeUser,
        fastTaskModelRefId: modelRefId || undefined,
      });
      setModelStatus({ tone: "muted", message: i18n._("Fast task model saved.") });
    } catch (error) {
      setModelStatus({
        tone: "destructive",
        message: errorMessage(error, i18n._("Unable to save fast task model")),
      });
    } finally {
      setUpdatingModelSettings(false);
    }
  };

  const updateModelSharing = async (model: ModelRef) => {
    setUpdatingModelSettings(true);
    setModelStatus({ tone: "muted", message: i18n._("Saving model sharing...") });
    try {
      await upsertModelRef(model);
      setModelStatus({ tone: "muted", message: i18n._("Model sharing saved.") });
    } catch (error) {
      setModelStatus({
        tone: "destructive",
        message: errorMessage(error, i18n._("Unable to save model sharing")),
      });
    } finally {
      setUpdatingModelSettings(false);
    }
  };

  const saveAppearanceSettings = () => {
    setThemePreference(draftThemePreference);
    setAppearanceSaveMessage(i18n._("Appearance saved."));
  };

  return (
    <SettingsLayout
      title={i18n._("Settings")}
      backLabel={i18n._("Back to harness")}
      onBack={() => navigate("/")}
      activeSection={activeSection}
      sections={settingsSections.map((item) => ({
        ...item,
        label: i18n._(item.label),
        to: `/settings/${item.id}`,
      }))}
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
      {activeSection === "api-keys" ? <ApiKeySettings /> : null}
      {activeSection === "users" ? <UserSettings /> : null}
      {activeSection === "account" ? <AccountSettings /> : null}
    </SettingsLayout>
  );
}
