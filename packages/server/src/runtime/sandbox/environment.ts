export const containerHome = "/home/agent";
export const containerVenv = `${containerHome}/.venvs/default`;
export const containerPath = `${containerVenv}/bin:${containerHome}/.npm-global/bin:${containerHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

export const runnerEnvironment = {
  HOME: containerHome,
  VIRTUAL_ENV: containerVenv,
  PATH: containerPath,
  NPM_CONFIG_PREFIX: `${containerHome}/.npm-global`,
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  AGENT_BROWSER_SESSION: "carmel",
};

// Run before executing any agent code. Bind mounts hide directories created in
// the image, so initialize the Python environment here as the sandbox user.
// Persist it across recreation; fail clearly when an image upgrade changes ABI.
export const prepareRunnerScript = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const [uid, gid, workspace] = process.argv.slice(1);
if (process.getuid() !== Number(uid) || process.getgid() !== Number(gid) || process.getuid() === 0) throw new Error('Sandbox user mapping did not take effect');
for (const path of [workspace, '/tmp', process.env.HOME]) {
  fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}
for (const path of ['/tmp', process.env.HOME]) {
  const stat = fs.statSync(path);
  if (stat.uid !== Number(uid) || stat.gid !== Number(gid)) throw new Error('Incorrect owner of ' + path + '; check the host UID/GID and existing data ownership');
}
const venv = process.env.VIRTUAL_ENV;
const check = spawnSync('/usr/bin/python3', ['-c', 'import sys; print(str(sys.version_info.major) + "." + str(sys.version_info.minor))'], { encoding: 'utf8' });
if (check.status !== 0) throw new Error('Runner image requires Python 3 and python3-venv');
const version = check.stdout.trim();
const marker = venv + '/.carmel-python-version';
if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() !== version) throw new Error('Runner Python version changed; move aside ' + venv + ' and reinstall its packages');
if (!fs.existsSync(marker)) {
  const result = spawnSync('/usr/bin/python3', ['-m', 'venv', venv], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Cannot initialize the agent Python environment; rebuild the runner with python3-venv');
  fs.writeFileSync(marker, version);
}
const ready = spawnSync(venv + '/bin/python', ['-m', 'pip', '--version'], { stdio: 'inherit' });
if (ready.status !== 0) throw new Error('The persistent Python environment is incomplete; move aside ' + venv + ' and reinstall its packages');
`;
