/** Only run in a newly created container, before exposing it to any agent tools.
 * The previous container must be confirmed removed first. Chromium's process
 * locks refer to that old PID/hostname; the rest of the profile is persistent.
 */
export const prepareBrowserProfileScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const profile = process.argv[1];
for (const name of ['SingletonCookie', 'SingletonSocket', 'SingletonLock']) {
  const file = path.join(profile, name);
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) throw new Error('Unexpected browser profile lock type: ' + name);
    fs.unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
`;
