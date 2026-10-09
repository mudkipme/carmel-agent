import { closeSync, constants, mkdirSync, openSync, statSync } from "node:fs";
import { posix } from "node:path";

export type MountDirectory = { source: string; target: string; readOnly?: boolean };

/**
 * OCI runtimes create missing nested bind targets as container root. With
 * keep-id that leaves subordinate-UID files on the host (e.g. a manual
 * /tmp/project workspace nested in our private /tmp bind). Create those targets
 * as the server user first. Never follow agent-controlled symlinks while doing
 * so: hold each directory open and address its child through /proc/self/fd.
 */
export function prepareNestedMountpoints(mounts: MountDirectory[]) {
  for (const mount of mounts) {
    const parent = mounts
      .filter((other) => other !== mount && isBelow(other.target, mount.target))
      .sort((a, b) => b.target.length - a.target.length)[0];
    if (!parent) continue;
    const parts = posix.relative(parent.target, mount.target).split("/");
    let fd: number | undefined;
    try {
      const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
      fd = openSync(parent.source, directoryFlags);
      for (const [index, part] of parts.entries()) {
        const child = `/proc/self/fd/${fd}/${part}`;
        const last = index === parts.length - 1;
        if (last && !statSync(mount.source).isDirectory()) {
          const flags =
            constants.O_RDONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            (parent.readOnly ? 0 : constants.O_CREAT);
          closeSync(openSync(child, flags, 0o644));
        } else {
          if (!parent.readOnly) {
            try {
              mkdirSync(child);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
          }
          const next = openSync(child, directoryFlags);
          closeSync(fd);
          fd = next;
        }
      }
    } catch (error) {
      throw new Error(
        `Cannot prepare nested sandbox mount ${mount.target}. Its sources must be accessible to the server and its parent directories writable, without symlinks.`,
        { cause: error },
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

function isBelow(parent: string, child: string) {
  const rel = posix.relative(parent, child);
  return Boolean(rel && rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel));
}
