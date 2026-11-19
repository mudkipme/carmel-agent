import { agentsApi } from "./api/agents.ts";
import { sessionsApi } from "./api/sessions.ts";
import { workspaceApi } from "./api/workspace.ts";

export {
  ApiError,
  apiError,
  apiFetch,
  apiUrl,
  call,
  type BootstrapPayload,
  type EditSessionMessageOptions,
  type UploadOptions,
} from "./api/core.ts";

export const api = {
  ...workspaceApi,
  ...agentsApi,
  ...sessionsApi,
};
