const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { isInside } = require('../src/runtime.cjs');
const localRequire = createRequire(path.join(__dirname, '../src/cutout.cjs'));
const cutoutCode = fs.readFileSync(path.join(__dirname, '../src/cutout.cjs'), 'utf8');
const mainCode = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

async function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-cutout-storage-'));
  const failures = [];
  const check = async (label, fn) => {
    try { await fn(); console.log(`PASS ${label}`); }
    catch (error) { failures.push(label); console.error(`FAIL ${label}: ${error.message}`); }
  };
  try {
    const make = (name, lockedName = '') => {
      const root = path.join(fixture, name);
      const output = path.join(root, 'output/ai-cutout');
      const assets = path.join(root, 'user/cutout-assets');
      fs.mkdirSync(output, { recursive: true });
      fs.mkdirSync(assets, { recursive: true });
      const entries = ['a', 'b'].map(id => ({ id, filename: `${id}.png`, sourceName: `${id}-source.png`, originalName: `${id}.png`, createdAt: 1 }));
      for (const entry of entries) {
        fs.writeFileSync(path.join(output, entry.filename), 'result');
        fs.writeFileSync(path.join(assets, entry.sourceName), 'source');
      }
      const history = path.join(root, 'user/studio-cutouts.json');
      fs.writeFileSync(history, JSON.stringify(entries));
      const mockedFs = Object.create(fs);
      let locked = lockedName;
      mockedFs.unlinkSync = file => {
        if (path.basename(file) === locked) throw Object.assign(new Error('file is locked'), { code: 'EPERM' });
        fs.unlinkSync(file);
      };
      const moduleObject = { exports: {} };
      vm.runInNewContext(cutoutCode, { module: moduleObject, require: name => name === 'fs' ? mockedFs : localRequire(name), console });
      let writeError = false;
      const service = moduleObject.exports.createCutoutService({ rootDir: () => root,
        atomicWriteText: (file, value) => { if (writeError) throw new Error('disk full'); fs.writeFileSync(file, value); }, requestJson: async () => ({}), reportProgress() {}, getPort: () => 1 });
      return { service, root, output, assets, history, unlock: () => { locked = ''; }, failWrites: value => { writeError = value; } };
    };
    await check('clear keeps locked results, their source copies and history; retries succeed', () => {
      const item = make('locked-output', 'a.png');
      const result = item.service.clear();
      assert.equal(result.ok, false);
      assert.equal(result.entries, 1);
      assert.equal(result.failed, 1);
      assert.ok(fs.existsSync(path.join(item.output, 'a.png')));
      assert.ok(fs.existsSync(path.join(item.assets, 'a-source.png')));
      assert.equal(item.service.list().length, 1);
      assert.equal(item.service.list()[0].id, 'a');
      item.unlock();
      assert.equal(item.service.clear().ok, true);
      assert.equal(item.service.list().length, 0);
    });
    await check('source cleanup failure stays visible and can be retried after output deletion', () => {
      const item = make('locked-source', 'a-source.png');
      const result = item.service.clear();
      assert.equal(result.ok, false);
      assert.equal(result.failed, 1);
      const visible = item.service.list();
      assert.equal(visible.length, 1);
      assert.equal(visible[0].missingOutput, true);
      item.unlock();
      assert.equal(item.service.remove('a').ok, true);
      assert.equal(item.service.list().length, 0);
      assert.equal(fs.existsSync(path.join(item.assets, 'a-source.png')), false);
    });
    await check('externally missing results retain a cleanup entry and source copy', () => {
      const item = make('missing-output');
      fs.unlinkSync(path.join(item.output, 'a.png'));
      assert.equal(item.service.list().length, 2);
      assert.equal(item.service.list().find(entry => entry.id === 'a').missingOutput, true);
      assert.equal(item.service.remove('a').ok, true);
      assert.equal(fs.existsSync(path.join(item.assets, 'a-source.png')), false);
    });
    await check('malformed cutout history cannot trigger deletion', () => {
      const item = make('bad-history');
      for (const broken of ['[null]', '[{"id":"a"}]', '{broken']) {
        fs.writeFileSync(item.history, broken);
        assert.throws(() => item.service.clear(), /抠图历史/);
        assert.equal(fs.readFileSync(item.history, 'utf8'), broken);
        assert.ok(fs.existsSync(path.join(item.output, 'a.png')));
      }
    });
    await check('history write failure preserves records and allows another cleanup attempt', () => {
      const item = make('full-disk');
      const original = fs.readFileSync(item.history, 'utf8');
      item.failWrites(true);
      const result = item.service.remove('a');
      assert.equal(result.ok, false);
      assert.equal(result.changed, true);
      assert.match(result.error, /历史保存失败/);
      assert.equal(fs.readFileSync(item.history, 'utf8'), original);
      assert.equal(item.service.list().find(entry => entry.id === 'a').missingOutput, true);
      item.failWrites(false);
      assert.equal(item.service.remove('a').ok, true);
    });
    await check('one cutout batch uses one frozen output folder name', async () => {
      const input = path.join(fixture, 'sample.png');
      fs.writeFileSync(input, 'image');
      const names = [];
      const batch = vm.runInNewContext(section(mainCode, 'async function runCutoutBatch(', 'function createWindow(') + ';runCutoutBatch', {
        fs, path, crypto, activeAiTool: null, processQueue() {}, voiceService: null, updateInProgress: false, backendReady: true, activeCutoutBatch: null,
        workflowIdFromValue: () => 'cutout', readWorkflowConfig: () => ({ ok: true, content: '{}' }), validateCutoutGraph: () => '',
        imageAssetPattern: /\.png$/i, emit() {},
        cutoutService: { run: async job => { names.push(job.cutoutOptions.batchName); return { outputPath: 'result.png' }; } },
      });
      // Distinct inputs make a batch; duplicate sources are intentionally ignored.
      const second = path.join(fixture, 'sample-2.png'); fs.writeFileSync(second, 'image-2');
      const result = await batch({ workflow: 'cutout', media: [input, second], cutoutOptions: { batchFolder: true, batchName: '' } });
      assert.equal(result.ok, true);
      assert.equal(names.length, 2);
      assert.equal(typeof names[0], 'string');
      assert.ok(names[0].length > 0);
      assert.equal(names[0], names[1]);
    });
    await check('partial cleanup refreshes UI and keeps error feedback', async () => {
      const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/main.jsx'), 'utf8');
      let refreshed = 0, status = '', recent = [{ id: 'a' }, { id: 'b' }];
      const context = { window: { studio: { clearCutouts: async () => ({ ok: false, changed: true, error: 'one file locked' }) } },
        refreshCutouts: async () => { refreshed++; return [{ id: 'a' }]; }, setCutoutRecentResults: fn => { recent = fn(recent); }, setStatus: value => { status = value; } };
      const clear = vm.runInNewContext(section(ui, '  const clearCutoutResults = async', '  const moveCutoutImage') + ';clearCutoutResults', context);
      await clear();
      assert.equal(refreshed, 1);
      assert.equal(status, 'one file locked');
      assert.deepEqual(recent, [{ id: 'a' }]);
    });
    assert.deepEqual(failures, []);
  } finally {
    assert.ok(isInside(os.tmpdir(), fixture) && path.basename(fixture).startsWith('h3-cutout-storage-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
