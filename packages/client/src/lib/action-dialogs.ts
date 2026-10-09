export type ConfirmRequest = {
  kind: "confirm";
  title: string;
  description: string;
  actionLabel: string;
  resolve: (value: boolean) => void;
};

export type PromptRequest = {
  kind: "prompt";
  title: string;
  description?: string;
  initialValue: string;
  actionLabel: string;
  resolve: (value: string | null) => void;
};

export type ActionDialogRequest = ConfirmRequest | PromptRequest;
let current: ActionDialogRequest | null = null;
const listeners = new Set<() => void>();

export function confirmAction(options: {
  title: string;
  description: string;
  actionLabel?: string;
}) {
  return enqueue<boolean>((resolve) => ({
    kind: "confirm",
    actionLabel: options.actionLabel ?? "Continue",
    ...options,
    resolve,
  }));
}

export function promptText(options: {
  title: string;
  description?: string;
  initialValue?: string;
  actionLabel?: string;
}) {
  return enqueue<string | null>((resolve) => ({
    kind: "prompt",
    title: options.title,
    description: options.description,
    initialValue: options.initialValue ?? "",
    actionLabel: options.actionLabel ?? "Save",
    resolve,
  }));
}

export function subscribeActionDialogs(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActionDialogSnapshot() {
  return current;
}

export function resolveActionDialog(value: boolean | string | null) {
  const request = current;
  current = null;
  emit();
  if (!request) return;
  if (request.kind === "confirm") request.resolve(value === true);
  else request.resolve(typeof value === "string" ? value : null);
}

function enqueue<T>(create: (resolve: (value: T) => void) => ActionDialogRequest): Promise<T> {
  if (current?.kind === "confirm") current.resolve(false);
  else if (current) current.resolve(null);
  return new Promise<T>((resolve) => {
    current = create(resolve);
    emit();
  });
}

function emit() {
  for (const listener of listeners) listener();
}
