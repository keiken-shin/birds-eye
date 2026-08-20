/**
 * What the remote-scan form accepts before it reaches the ssh command line.
 *
 * These are a trust boundary, not a politeness check: the destination is passed
 * to `ssh` as an argument, so a value starting with "-" (`-oProxyCommand=…`)
 * would be read as an option and run a command on the person's own machine.
 * Each function returns the message to show, or null when the field is fine.
 * Empty is "not finished yet", never an error — the start button stays disabled
 * on emptiness alone.
 */

/** "user@host", a bare hostname, or an ~/.ssh/config alias — nothing that reads as a flag. */
const HOST = /^[A-Za-z0-9._@-]+$/;

export function hostError(value: string): string | null {
  const host = value.trim();
  if (!host) return null;
  return HOST.test(host) && !host.startsWith("-")
    ? null
    : "That doesn't look like a host — use user@host or the name from your SSH config.";
}

/** The remote is POSIX, so its folder is an absolute path. */
export function rootError(value: string): string | null {
  const root = value.trim();
  if (!root) return null;
  return root.startsWith("/")
    ? null
    : "The folder has to be a full path on that host, starting with / — like /home/user.";
}

/** Empty means the host's own default (22); anything else has to be a real TCP port. */
export function portError(value: string): string | null {
  const port = value.trim();
  if (!port) return null;
  return /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535
    ? null
    : "The port has to be a number between 1 and 65535.";
}
