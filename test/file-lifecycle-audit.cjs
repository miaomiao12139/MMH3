const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const cutoutRequire = require('node:module').createRequire(path.join(__dirname, '../src/cutout.cjs'));
const { isInside } = require('../src/runtime.cjs');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-lifecycle-'));
  const failures = [];
  const check = async (name, action) => {
    try { await action(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  };
  try {
    const output = path.join(root, 'output');
    fs.mkdirSync(output);
    const handlers = new Map();
    let metadata = {};
    let jobs = [];
    const context = {
      fs: Object.create(fs), path, rootDir: () => root, win: null,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      outputFilePath: file => isInside(output, file) ? file : null,
      isWithin: isInside, readStudioHistory: () => structuredClone(metadata),
      writeStudioHistory: value => { metadata = structuredClone(value); },
      readQueueJobs: () => jobs, writeQueueJobs: () => true, emitQueue() {},
      listVideoFiles: () => fs.readdirSync(output).map(name => ({ path: path.join(output, name), workflow: 't2v' })),
      atomicWriteText: (file, text) => fs.writeFileSync(file, text),
    };
    const safeStart = main.indexOf('function safeFileName(');
    vm.runInNewContext(main.slice(safeStart, main.indexOf('function verifyPythonExecutable(', safeStart)), context);
    for (const [start, end] of [
      ['ipcMain.handle("rename-video"', 'ipcMain.handle("export-video"'],
      ['ipcMain.handle("clear-videos"', 'ipcMain.handle("open-video"'],
    ]) vm.runInNewContext(main.slice(main.indexOf(start), main.indexOf(end)), context);
    const rename = handlers.get('rename-video');
    const original = path.join(output, 'clip.mp4');
    fs.writeFileSync(original, 'video');
    await check('rename to same filename preserves prompt and seed', async () => {
      metadata = { 'clip.mp4': { prompt: 'keep', seed: 0, favorite: true } };
      assert.equal((await rename(null, original, 'clip.mp4')).ok, true);
      assert.equal(metadata['clip.mp4']?.prompt, 'keep');
    });
    await check('rename preserves dots and updates completed queue output paths', async () => {
      metadata = { 'clip.mp4': { prompt: 'keep', seed: 0 } };
      jobs = [{ outputPath: original, outputPaths: [original] }];
      const result = await rename(null, original, '旅行.v2');
      assert.equal(result.ok, true);
      const expected = path.join(output, '旅行.v2.mp4');
      assert.equal(result.path, expected);
      assert.equal(jobs[0].outputPath, expected);
      assert.equal(jobs[0].outputPaths[0], expected);
      assert.equal(metadata['旅行.v2.mp4'].seed, 0);
    });
    await check('rename restores filename if saving metadata fails', async () => {
      const before = path.join(output, 'rollback.mp4');
      fs.writeFileSync(before, 'original');
      metadata['rollback.mp4'] = { prompt: 'preserve' };
      const writer = context.writeStudioHistory;
      context.writeStudioHistory = () => { throw new Error('disk full'); };
      try {
        const result = await rename(null, before, 'after');
        assert.equal(result.ok, false);
        assert.match(result.error, /disk full/);
        assert.equal(fs.existsSync(before), true);
        assert.equal(fs.existsSync(path.join(output, 'after.mp4')), false);
        assert.equal(metadata['rollback.mp4'].prompt, 'preserve');
      } finally { context.writeStudioHistory = writer; }
    });
    await check('partial bulk deletion reports failure and keeps failed file metadata', async () => {
      for (const name of fs.readdirSync(output)) fs.unlinkSync(path.join(output, name));
      for (const name of ['good.mp4', 'locked.mp4']) fs.writeFileSync(path.join(output, name), name);
      metadata = { 'good.mp4': { prompt: 'good' }, 'locked.mp4': { prompt: 'locked', favorite: true } };
      const user = path.join(root, 'user');
      fs.mkdirSync(user, { recursive: true });
      fs.writeFileSync(path.join(user, 'studio-history.json'), JSON.stringify(metadata));
      context.fs.unlinkSync = file => {
        if (path.basename(file) === 'locked.mp4') throw Object.assign(new Error('file locked'), { code: 'EPERM' });
        fs.unlinkSync(file);
      };
      const result = await handlers.get('clear-videos')(null, 't2v');
      assert.equal(result.ok, false);
      assert.equal(result.count, 1);
      assert.equal(result.failed, 1);
      assert.equal(fs.existsSync(path.join(output, 'locked.mp4')), true);
      // The handler uses the same history writer as generation and rename.
      assert.equal(metadata['locked.mp4']?.prompt, 'locked');
      assert.equal(metadata['good.mp4'], undefined);
    });

    const cutoutCode = fs.readFileSync(path.join(__dirname, '../src/cutout.cjs'), 'utf8');
    for (const scenario of ['timeout', 'request-error', 'cancel-during-submit', 'missing-id', 'engine-error', 'success']) {
      await check(`cutout ${scenario}: scoped engine cleanup and input lifecycle`, async () => {
        let clock = 0;
        let submittedGraph;
        const task = {};
        const requests = [];
        class Socket extends EventEmitter { terminate() {} }
        const moduleObject = { exports: {} };
        vm.runInNewContext(cutoutCode, {
          module: moduleObject, structuredClone, console,
          Date: class extends Date { static now() { return clock; } },
          setTimeout: callback => { clock += 21 * 60 * 1000; callback(); return 1; }, clearTimeout() {},
          require: name => name === 'ws' ? Socket : cutoutRequire(name),
        });
        const service = moduleObject.exports.createCutoutService({
          rootDir: () => root, getPort: () => 1, reportProgress() {},
          atomicWriteText: (file, text) => fs.writeFileSync(file, text),
          requestJson: async (method, route, body) => {
            requests.push({ method, route, body });
            if (route.startsWith('/object_info')) return { InspyrenetRembg: {} };
            if (route === '/prompt') {
              submittedGraph = body.prompt;
              if (scenario === 'missing-id') return { error: { message: '参数校验失败' }, node_errors: { '2': { class_type: 'InspyrenetRembg', errors: [{ message: '缺少模型' }] } } };
              if (scenario === 'cancel-during-submit') task.canceled = true;
              if (scenario === 'success') {
                const prefix = Object.values(submittedGraph).find(n => n.class_type === 'SaveImage').inputs.filename_prefix;
                fs.writeFileSync(path.join(output, `${prefix}.png`), 'png');
              }
              return { prompt_id: 'own-cutout' };
            }
            if (route.startsWith('/history/')) {
              if (scenario === 'request-error') throw new Error('connection lost');
              if (scenario === 'engine-error') return { 'own-cutout': { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } };
              if (scenario === 'success') {
                const [saveId, save] = Object.entries(submittedGraph).find(([, n]) => n.class_type === 'SaveImage');
                return { 'own-cutout': { status: { status_str: 'success' }, outputs: { [saveId]: { images: [{ type: 'output', subfolder: 'ai-cutout', filename: `${path.basename(save.inputs.filename_prefix)}.png` }] } } } };
              }
            }
            return {};
          },
        });
        const source = path.join(root, 'source.png');
        fs.writeFileSync(source, 'source');
        const graph = { '1': { class_type: 'LoadImage', inputs: {} }, '2': { class_type: 'InspyrenetRembg', inputs: { image: ['1', 0] } }, '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } } };
        const promise = service.run({ id: 'test', workflowGraph: graph, media: [source] }, task);
        if (scenario === 'success') assert.ok((await promise).outputPath);
        else await assert.rejects(promise, scenario === 'request-error' ? /connection lost/ : scenario === 'missing-id' ? /InspyrenetRembg.*缺少模型/ : scenario === 'engine-error' ? /CUDA out of memory/ : scenario === 'cancel-during-submit' ? /任务已取消/ : /超时/);
        const interrupts = requests.filter(r => r.route === '/interrupt');
        assert.equal(interrupts.length, ['missing-id', 'engine-error', 'success'].includes(scenario) ? 0 : 1);
        assert.ok(interrupts.every(r => r.body.prompt_id === 'own-cutout'));
        assert.equal(fs.readdirSync(path.join(root, 'input')).length, 0);
        assert.equal(fs.existsSync(source), true);
      });
    }
    await check('partial deletion refreshes UI and displays error', async () => {
      const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/main.jsx'), 'utf8');
      const start = renderer.indexOf('  const clearHistory = async () => {');
      let refreshed = false;
      let status = '';
      const clear = vm.runInNewContext(renderer.slice(start, renderer.indexOf('  const toggleVideoFavorite', start)) + ';clearHistory', {
        current: { id: 't2v' }, window: { studio: { clearVideos: async () => ({ ok: false, count: 1, failed: 1, error: 'locked' }) } },
        setSelectedVideo() {}, refreshHistory: async () => { refreshed = true; }, setStatus: text => { status = text; },
      });
      await clear();
      assert.equal(refreshed, true);
      assert.equal(status, 'locked');
    });
    assert.deepEqual(failures, [], `Failed: ${failures.join(', ')}`);
  } finally {
    assert.ok(isInside(os.tmpdir(), root) && path.basename(root).startsWith('h3-lifecycle-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
