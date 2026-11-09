import { CARMEL_LINK_PLACEHOLDER } from "@carmel-agent/shared";

export function carmelPublicBaseUrl() {
  try {
    const url = new URL(process.env.CARMEL_PUBLIC_URL ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return;
  }
}

export function carmelLinkInstructions(agentId: string) {
  return [
    "Carmel links: use routes and IDs known from the conversation or tool results; never invent hosts or ports.",
    `Use ${CARMEL_LINK_PLACEHOLDER} as the base for every Carmel link; it resolves to the app's public URL or an app-relative path.`,
    `Home: ${CARMEL_LINK_PLACEHOLDER}/agents/${encodeURIComponent(agentId)}/home.`,
  ].join("\n");
}
