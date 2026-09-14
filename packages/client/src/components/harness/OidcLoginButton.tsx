import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { startOidcLogin } from "@/lib/auth-errors";

export function OidcLoginButton({
  providerName,
  label = `Sign in with ${providerName}`,
  variant = "default",
}: {
  providerName: string;
  label?: string;
  variant?: "default" | "outline";
}) {
  // The page is about to navigate away; disabling guards against a second
  // click starting a second flow that would orphan the first.
  const [redirecting, setRedirecting] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      disabled={redirecting}
      onClick={() => {
        setRedirecting(true);
        startOidcLogin();
      }}
    >
      <KeyRoundIcon data-icon="inline-start" />
      {redirecting ? `Redirecting to ${providerName}` : label}
    </Button>
  );
}
