/** Runs in the sandbox with Node 24. The only host connection is Docker exec stdio. */
export const browserBridgeScript = String.raw`
const { execFile } = require('node:child_process');
const { createInterface } = require('node:readline');
let stream, closed = false, refreshTimer;
const children = new Set();
const send = message => { if (!closed) process.stdout.write(JSON.stringify(message) + '\n'); };
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/local/bin/agent-browser', ['--session', 'carmel', '--json', ...args],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        children.delete(child);
        try {
          const result = JSON.parse(stdout);
          if (!result.success) throw new Error(result.error || 'Browser command failed.');
          if (error) throw error;
          resolve(result.data);
        } catch { reject(new Error('Browser command failed. Check that the runner has agent-browser 0.38.2 and Chromium.')); }
      });
    children.add(child);
  });
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
    if (message.type === 'command') {
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
})().catch(() => { send({type:'error',message:'Unable to start the browser. Rebuild the sandbox runner with agent-browser 0.38.2.'}); stop(); });
`;
