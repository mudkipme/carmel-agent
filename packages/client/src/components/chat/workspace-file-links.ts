import { createContext } from "react";

/** The agent whose workspace relative markdown links open in; unset renders them as plain links. */
export const WorkspaceFileLinkAgentContext = createContext<string | undefined>(undefined);

/** A rendered document resolves its links and images from its own directory. */
export const WorkspaceFilePathContext = createContext<string | undefined>(undefined);
