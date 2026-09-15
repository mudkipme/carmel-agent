import { createContext } from "react";

/** The agent whose workspace relative markdown links open in; unset renders them as plain links. */
export const WorkspaceFileLinkAgentContext = createContext<string | undefined>(undefined);
