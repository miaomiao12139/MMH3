const WebSocket = require('ws');
async function evaluate(expression, kind = 'file:') {
  const targets = await (await fetch('http://127.0.0.1:9230/json/list')).json();
  const target = targets.find(t => t.type === 'page' && t.url.startsWith(kind));
  if (!target) throw new Error(`No target ${kind}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  try {
    const result = await new Promise((resolve, reject) => {
      socket.on('message', raw => { const msg = JSON.parse(raw); if (msg.id === 1) resolve(msg.result); });
      socket.once('error', reject);
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } finally { socket.close(); }
}
module.exports = { evaluate };
if (require.main === module) evaluate(process.argv[2], process.argv[3]).then(v => console.log(JSON.stringify(v, null, 2))).catch(e => { console.error(e); process.exitCode = 1; });
