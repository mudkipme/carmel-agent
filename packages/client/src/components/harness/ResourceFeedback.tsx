import { useLingui } from "@lingui/react";
import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function ResourceError({
  error,
  onRetry,
  title = i18n._("Unable to load updates"),
}: {
  error: string;
  onRetry: () => unknown;
  title?: string;
}) {
  useLingui();
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{error}</p>
        <Button variant="outline" size="sm" onClick={() => void onRetry()}>
          <Trans>Retry</Trans>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function ResourceLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
