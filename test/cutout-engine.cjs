// Optional GPU check against the running packaged engine. Uses only UUID test files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { evaluate } = require('./cdp-eval.cjs');
const { cancelPrompt, describeEngineError } = require('../src/runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '../../../App');
  const backend = await evaluate('window.studio.getBackendUrl()');
  assert.match(backend, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
  const request = async (method, route, payload) => {
    const response = await fetch(new URL(route, backend), {
      method, signal: AbortSignal.timeout(15000),
      ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
    });
    assert.ok(response.ok, `${route}: ${response.status}`);
    const body = await response.text();
    return body ? JSON.parse(body) : {};
  };
  const queue = await request('GET', '/queue');
  assert.equal(queue.queue_running.length + queue.queue_pending.length, 0, 'Engine must be idle');
  const marker = `self-audit-cutout-${randomUUID()}`;
  const input = path.join(root, 'input', `${marker}.png`);
  const outputRoot = path.resolve(root, 'output');
  const output = path.resolve(outputRoot, marker);
  assert.equal(path.dirname(output), outputRoot);
  assert.ok(path.basename(output).startsWith('self-audit-cutout-'));
  const graph = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows/InspyrenetRembg抠图.json'), 'utf8'));
  graph['14'].inputs.image = path.basename(input);
  graph['16'].inputs.filename_prefix = `${marker}/result`;
  let promptId, complete = false;
  try {
    fs.copyFileSync(path.join(__dirname, 'fixtures/upgrade-native-test.png'), input, fs.constants.COPYFILE_EXCL);
    const submitted = await request('POST', '/prompt', { prompt: graph, client_id: marker });
    assert.ok(submitted.prompt_id, describeEngineError(submitted));
    promptId = submitted.prompt_id;
    const deadline = Date.now() + 120000;
    let record;
    while (Date.now() < deadline) {
      record = (await request('GET', `/history/${promptId}`))[promptId];
      if (record) { complete = true; break; }
      await pause(500);
    }
    assert.ok(record, 'Cutout inference timed out');
    assert.equal(record.status?.status_str, 'success', describeEngineError(record));
    const image = record.outputs?.['16']?.images?.[0];
    assert.equal(image?.type, 'output');
    assert.equal(image.subfolder.replace(/\\/g, '/'), marker);
    const file = path.resolve(output, image.filename);
    assert.equal(path.dirname(file), output);
    const inspection = JSON.parse(execFileSync(path.join(root, 'python/python.exe'), ['-c',
      "from PIL import Image; import sys,json; im=Image.open(sys.argv[1]); im.load(); print(json.dumps(dict(format=im.format,mode=im.mode,size=im.size,alpha=im.getchannel('A').getextrema())))", file], { encoding: 'utf8', windowsHide: true }));
    assert.equal(inspection.format, 'PNG');
    assert.equal(inspection.mode, 'RGBA');
    assert.ok(inspection.size.every(value => value > 0));
    console.log(JSON.stringify({ ok: true, node: 'InspyrenetRembg', ...inspection }));
  } finally {
    if (promptId && !complete) await cancelPrompt(request, promptId);
    if (promptId) await request('POST', '/history', { delete: [promptId] });
    if (fs.existsSync(input)) fs.unlinkSync(input);
    if (fs.existsSync(output)) {
      // Never recurse; remove only files produced in this unique test directory.
      for (const name of fs.readdirSync(output)) {
        assert.match(name, /^result_\d+_\.png$/);
        fs.unlinkSync(path.join(output, name));
      }
      fs.rmdirSync(output);
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
