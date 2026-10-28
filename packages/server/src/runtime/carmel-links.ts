export function carmelLinkInstructions(agentId: string) {
  const guidance =
    "Carmel links: use routes and IDs known from the conversation or tool results; never invent hosts or ports. Prefer app-relative links in web chat.";
  const relativeOnly = `${guidance} CARMEL_PUBLIC_URL is unavailable; keep Carmel links app-relative.`;
  try {
    const url = new URL(process.env.CARMEL_PUBLIC_URL ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return relativeOnly;
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return `${guidance}\nCARMEL_PUBLIC_URL: ${base}\nFor absolute links, append app-relative paths to this base, preserving its path prefix. Home: ${base}/agents/${encodeURIComponent(agentId)}/home.`;
  } catch {
    return relativeOnly;
  }
}
