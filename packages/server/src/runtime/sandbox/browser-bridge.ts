/** Runs in the sandbox with Node 24. The only host connection is Docker exec stdio. */
export const browserBridgeScript = String.raw`
const { execFile } = require('node:child_process');
const { createInterface } = require('node:readline');
let stream, closed = false, refreshTimer;
const children = new Set();
const send = message => { if (!closed) process.stdout.write(JSON.stringify(message) + '\n'); };
function commandError(args, error, stdout, stderr) {
  // Never forward raw CLI output: it may contain page content or credentials.
  let detail = stderr || '';
  try { detail += JSON.parse(stdout).error || ''; } catch {}
  if (/profile appears to be in use|ProcessSingleton|SingletonLock|user data directory is already in use/i.test(detail)) {
    return new Error('The browser profile is locked by another Chromium process or a previous sandbox. Ask the administrator to recover this agent\'s stale profile lock; saved sign-ins should be retained.');
  }
  if (error?.code === 'ENOENT' || /unknown command.*stream|unrecognized.*stream/i.test(detail)) {
    return new Error('The runner is missing compatible browser tooling. Rebuild it with agent-browser 0.38.2 and Chromium.');
  }
  if (error?.killed) return new Error('The browser command timed out (' + args.slice(0, 2).join(' ') + '). Reconnect to try again.');
  return new Error('The browser command failed (' + args.slice(0, 2).join(' ') + '). Check this agent\'s sandbox browser process and profile.');
}
function cli(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/local/bin/agent-browser', ['--session', 'carmel', '--json', ...args],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        children.delete(child);
        try {
          const result = JSON.parse(stdout);
          if (!result.success) throw new Error(result.error || 'Browser command failed.');
          if (error) throw error;
          resolve(result.data);
        } catch { reject(commandError(args, error, stdout, stderr)); }
      });
    children.add(child);
    if (input !== undefined) {
      child.stdin.on('error', () => reject(new Error('Browser input disconnected.')));
      child.stdin.end(input);
    }
  });
}
// A separate local CDP connection grants clipboard access only for this operation.
// Restore the site's previous permission states; never grant access to every origin.
async function clipboard(message) {
  let cdp, previous, origin, granted = false;
  let rpcId = 0;
  const pending = new Map();
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')); }, 5000);
    pending.set(id, {resolve, reject, timer});
    cdp.send(JSON.stringify({id, method, params}));
  });
  const permission = (name, setting) => rpc('Browser.setPermission', {origin, permission:{name}, setting});
  let result;
  try {
    origin = new URL((await cli(['get', 'url'])).url).origin;
    previous = (await cli(['eval', 'Promise.all(["clipboard-read","clipboard-write"].map(async name => (await navigator.permissions.query({name})).state))'])).result;
    if (!Array.isArray(previous) || previous.length !== 2) throw new Error('Clipboard unavailable');
    const endpoint = new URL((await cli(['get', 'cdp-url'])).cdpUrl);
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)) throw new Error('Local browser required');
    cdp = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cdp.close(); reject(new Error('CDP timeout')); }, 5000);
      cdp.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
      cdp.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP unavailable')); }, {once:true});
    });
    cdp.addEventListener('message', event => {
      try {
        const response = JSON.parse(String(event.data)), request = pending.get(response.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(response.id);
        if (response.error) request.reject(new Error('Clipboard permission failed')); else request.resolve(response.result);
      } catch {}
    });
    granted = true;
    await permission('clipboard-read', 'granted');
    await permission('clipboard-write', 'granted');
    // Empty first so copying without a selection cannot return a previous user's clipboard.
    await cli(['clipboard', 'write', '']);
    if (message.operation === 'paste') {
      // Pass user text over stdin, never in process arguments or error messages.
      await cli(['eval', '--stdin'], 'navigator.clipboard.writeText(' + JSON.stringify(message.text) + ')');
      await cli(['clipboard', 'paste']);
      result = {type:'clipboard_result', requestId:message.requestId};
    } else {
      await cli(['clipboard', 'copy']);
      const {text} = await cli(['clipboard', 'read']);
      if (typeof text !== 'string' || text.length > 16384) throw new Error('Clipboard text exceeds limit');
      result = {type:'clipboard_result', requestId:message.requestId, text};
    }
  } catch {
    result = {type:'clipboard_result', requestId:message.requestId, error:'Clipboard transfer failed. Use a secure page and copy or paste at most 16,384 characters.'};
  } finally {
    if (granted) {
      // Do not leave the user's transferred text in the agent browser's clipboard.
      try { await cli(['clipboard', 'write', '']); } catch {}
      for (const [index, name] of ['clipboard-read','clipboard-write'].entries()) {
        try { await permission(name, previous[index]); } catch {}
      }
    }
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Clipboard disconnected')); }
    cdp?.close();
  }
  send(result);
}
let refreshing = false;
async function refresh() {
  if (refreshing || closed) return;
  refreshing = true;
  try {
    const result = await cli(['tab', 'list']);
    const tabs = (result.tabs || []).map((tab, index) => ({
      id: String(tab.tabId || tab.targetId || index), title: tab.title || 'Untitled', url: tab.url || '', active: Boolean(tab.active)
    }));
    send({ type: 'tabs', tabs });
    const active = tabs.find(tab => tab.active);
    if (active) send({type:'url', url:active.url});
  } catch { /* Stream status reports loss of the browser; the next refresh retries. */ }
  finally { refreshing = false; }
}
function stop() {
  if (closed) return;
  closed = true;
  clearInterval(refreshTimer);
  for (const child of children) child.kill();
  stream?.close();
  process.exit(0);
}
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
process.on('SIGTERM', stop);
const lines = createInterface({input:process.stdin});
let commands = Promise.resolve();
lines.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.type === 'clipboard') {
      commands = commands.then(() => clipboard(message));
    } else if (message.type === 'command') {
      commands = commands.then(async () => {
        try { await cli(message.args); await refresh(); }
        catch { send({type:'error',message:'The browser action failed. Try again.'}); }
        finally { send({type:'command_done',id:message.id}); }
      });
    } else if (stream?.readyState === WebSocket.OPEN) {
      // CDP dispatchKeyEvent accepts a single character. Sending a whole paste silently drops it.
      if (message.type === 'input_keyboard' && message.eventType === 'char') {
        for (const text of message.text || '') stream.send(JSON.stringify({...message, text}));
      } else stream.send(JSON.stringify(message));
    }
  } catch { /* Ignore malformed input. The Carmel gateway validates it first. */ }
});
(async () => {
  let status = await cli(['stream', 'status']);
  // Reading the URL launches a blank browser if needed, without navigating an existing tab.
  if (!status.connected) await cli(['get', 'url']);
  if (!status.enabled) await cli(['stream', 'enable']);
  status = await cli(['stream', 'status']);
  if (!Number.isInteger(status.port) || status.port < 1 || status.port > 65535) throw new Error('Browser stream is unavailable.');
  if (closed) return;
  stream = new WebSocket('ws://127.0.0.1:' + status.port + '/?pacing=ack&maxFps=15');
  stream.addEventListener('open', () => {
    send({type:'ready'});
    void refresh();
    refreshTimer = setInterval(refresh, 2000);
  });
  stream.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      if (['frame','status','url'].includes(message.type)) send(message);
    } catch {}
  });
  stream.addEventListener('error', () => { send({type:'error',message:'Browser stream disconnected.'}); stop(); });
  stream.addEventListener('close', stop);
})().catch(error => { send({type:'error',message:'Unable to start the browser. ' + error.message}); stop(); });
`;
