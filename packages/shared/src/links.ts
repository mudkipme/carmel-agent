/** Placeholder the model uses for Carmel's browser base URL. */
export const CARMEL_LINK_PLACEHOLDER = "{{CARMEL_URL}}";

/** Resolve model-authored Carmel links for the surface that renders them. */
export function resolveCarmelLinks(text: string, baseUrl?: string) {
  const base = baseUrl?.replace(/\/+$/, "") ?? "";
  return text.replaceAll(CARMEL_LINK_PLACEHOLDER, base);
}
