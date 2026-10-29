import { i18n } from "@lingui/core";
import type { OidcLoginErrorCode } from "@carmel-agent/shared";

/**
 * Take the `?auth_error=` code a refused single sign-on redirect leaves behind,
 * and drop it from the address bar so a reload does not show it again.
 */
export function takeOidcErrorCode() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("auth_error");
  if (!code) return undefined;
  url.searchParams.delete("auth_error");
  window.history.replaceState(window.history.state, "", url);
  return code;
}

// The server sends codes rather than sentences: the wording lives here, so a
// crafted link cannot put arbitrary text on the sign-in page.
export function oidcErrorMessage(code: string, providerName = i18n._("single sign-on")) {
  const messages: Record<OidcLoginErrorCode, string> = {
    not_allowed: i18n._("Your {providerName} account isn't allowed to use Carmel Agent.", {
      providerName: providerName,
    }),
    not_linked: i18n._(
      "No Carmel Agent account is linked to your {providerName} sign-in. Ask an administrator to create one.",
      { providerName: providerName },
    ),
    ambiguous_account: i18n._(
      "More than one Carmel Agent account matches your {providerName} sign-in. Ask an administrator to resolve it.",
      { providerName: providerName },
    ),
    already_linked: i18n._(
      "The matching Carmel Agent account is already linked to a different {providerName} sign-in.",
      { providerName: providerName },
    ),
    expired: i18n._("That sign-in expired or was started in another browser. Try again."),
    denied: i18n._("Sign-in with {providerName} was cancelled.", { providerName: providerName }),
    failed: i18n._(
      "Sign-in with {providerName} failed. Try again, or ask an administrator if it keeps happening.",
      { providerName: providerName },
    ),
  };
  return messages[code as OidcLoginErrorCode] ?? messages.failed;
}

/** A full-page navigation: the provider's sign-in page is not ours to fetch. */
export function startOidcLogin() {
  window.location.assign("/api/auth/oidc/login");
}
