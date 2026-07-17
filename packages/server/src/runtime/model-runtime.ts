import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export function createCarmelModelRuntime(credentials: CredentialStore = new InMemoryCredentialStore()) {
  return ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
}
