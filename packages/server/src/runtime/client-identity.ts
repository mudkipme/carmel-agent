import { PI_ATTRIBUTION, type ClientIdentity } from "@earendil-works/pi-ai/utils/identity";

export function piClientIdentity(): ClientIdentity {
  const value = process.env.PI_TELEMETRY;
  const enabled = value === undefined || ["1", "true", "yes"].includes(value.toLowerCase());
  return { attribution: enabled ? PI_ATTRIBUTION : null };
}
