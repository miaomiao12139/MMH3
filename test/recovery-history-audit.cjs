const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { relocateStoredPaths, isInside } = require('../src/runtime.cjs');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/main.jsx'), 'utf8');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

async function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-recovery-'));
  const failures = [];
  const check = async (label, fn) => {
    try { await fn(); console.log(`PASS ${label}`); }
    catch (error) { failures.push(label); console.error(`FAIL ${label}: ${error.message}`); }
  };
  try {
    const root = path.join(fixture, 'App');
    const user = path.join(root, 'user');
    fs.mkdirSync(user, { recursive: true });
    const queueFile = path.join(user, 'studio-queue.json');
    const input = path.join(user, 'queue-input/old-job/image.png');
    for (const damaged of ['{truncated', '{}', 'null', '[null]', '[{"id":"../outside","state":"queued"}]']) {
      await check(`damaged queue preserves its file and input cache: ${damaged}`, () => {
        fs.mkdirSync(path.dirname(input), { recursive: true });
        fs.writeFileSync(input, 'original media');
        fs.writeFileSync(queueFile, damaged);
        const context = { fs, path, rootDir: () => root, queueJobs: null, queueLoadError: '', relocateStoredPaths,
          readQueueRetentionDays: () => 30, queueInputsUsedByDraft: () => false, emit() {},
          atomicWriteText: (file, value) => fs.writeFileSync(file, value), queueStatePath: () => queueFile };
        const functions = vm.runInNewContext(section(source, 'function pruneQueueInputDirs(', 'function publicQueueJob(') + ';({readQueueJobs,writeQueueJobs,pruneQueueInputDirs})', context);
        functions.pruneQueueInputDirs();
        assert.equal(fs.existsSync(input), true);
        assert.equal(functions.writeQueueJobs(), false);
        assert.equal(fs.readFileSync(queueFile, 'utf8'), damaged);
        assert.match(context.queueLoadError, /队列/);
      });
    }
    await check('valid interrupted queue is recoverable; missing queue starts empty', () => {
      fs.writeFileSync(queueFile, JSON.stringify([{ id: 'old-job', state: 'running', workflowId: 'i2v', media: [input] }]));
      const make = () => vm.runInNewContext(section(source, 'function readQueueJobs(', 'function publicQueueJob(') + ';({readQueueJobs,writeQueueJobs})', {
        fs, path, rootDir: () => root, queueJobs: null, queueLoadError: '', relocateStoredPaths,
        emit() {}, atomicWriteText: (file, value) => fs.writeFileSync(file, value), queueStatePath: () => queueFile,
      });
      assert.equal(make().readQueueJobs()[0].state, 'interrupted');
      fs.unlinkSync(queueFile);
      assert.equal(make().readQueueJobs().length, 0);
    });
    await check('enqueue refuses a queue with a read error before staging inputs', async () => {
      const enqueue = vm.runInNewContext(section(source, 'async function enqueueWorkflow(', '// AI cutout uses') + ';enqueueWorkflow', {
        updateInProgress: false, backendReady: true, queueLoadError: '队列读取失败，原文件已保留', readQueueJobs: () => [],
      });
      await assert.rejects(enqueue({ workflow: 'i2v' }), /队列读取失败/);
    });
    await check('failed queue persistence does not report success or start GPU work', async () => {
      const jobs = [];
      let staged = false, cleaned = false, started = false;
      const enqueue = vm.runInNewContext(section(source, 'async function enqueueWorkflow(', '// AI cutout uses') + ';enqueueWorkflow', {
        updateInProgress: false, backendReady: true, queueLoadError: '', readQueueJobs: () => jobs,
        workflowIdFromValue: () => 't2v', readWorkflowConfig: () => ({ ok: true, content: '{}' }), validateWorkflowGraph: () => '',
        crypto, normalizeReferenceAsset() {}, validateGenerationInputs() {}, resolveGenerationSettings: () => ({}), applyGenerationSettings() {},
        stageQueueMedia: async () => { staged = true; return []; }, cleanupQueueMedia: () => { cleaned = true; },
        workflowFileName: () => 't2v.json', queueWorkflowNames: { t2v: '文生视频' }, path,
        writeQueueJobs: () => false, emitQueue() {}, processQueue: () => { started = true; }, publicQueueJob: job => job,
      });
      await assert.rejects(enqueue({ workflow: 't2v' }), /队列保存失败/);
      assert.equal(jobs.length, 0);
      assert.equal(staged, true);
      assert.equal(cleaned, true);
      assert.equal(started, false);
    });
    await check('history includes older workflows and favourites beyond 100 newer files', () => {
      const output = path.join(root, 'output');
      fs.mkdirSync(output);
      const old = path.join(output, 'i2v_old.mp4');
      fs.writeFileSync(old, 'old');
      fs.utimesSync(old, 1, 1);
      for (let i = 0; i < 101; i++) fs.writeFileSync(path.join(output, `t2v_${i}.mp4`), 'new');
      const metadata = { 'i2v_old.mp4': { workflow: 'i2v', prompt: 'old prompt', favorite: true } };
      const historyFile = path.join(user, 'studio-history.json');
      fs.writeFileSync(historyFile, JSON.stringify(metadata));
      let list;
      const context = { fs, path, pathToFileURL, rootDir: () => root, readStudioHistory: () => metadata,
        ipcMain: { handle: (_name, fn) => { list = fn; } } };
      vm.runInNewContext(section(source, 'function inferWorkflowFromOutput(', 'function outputFilePath(') + section(source, 'ipcMain.handle("list-videos"', 'ipcMain.handle("list-cutouts"'), context);
      const contents = fs.readFileSync(historyFile, 'utf8');
      const items = list();
      assert.ok(items.some(item => item.path === old && item.favorite));
      assert.equal(items.length, 102);
      assert.equal(fs.readFileSync(historyFile, 'utf8'), contents, 'Reading history must not rewrite it');
    });
    await check('refreshing a partial history response does not erase saved favourites', async () => {
      let favorites = ['old.mp4'];
      const refresh = vm.runInNewContext(section(ui, '  const refreshHistory = async', '  const refreshCutouts =') + ';refreshHistory', {
        window: { studio: { listVideos: async () => [{ path: 'recent.mp4' }] } },
        setHistory() {}, setStatus() {}, setVideoFavorites: fn => { favorites = fn(favorites); }, setSelectedVideo: fn => fn(''),
      });
      await refresh();
      assert.deepEqual(favorites, ['old.mp4']);
    });
    await check('damaged video history cannot be replaced by a favourite action', () => {
      const historyFile = path.join(user, 'studio-history.json');
      let favorite;
      const context = { fs, path, rootDir: () => root,
        atomicWriteText: (file, value) => fs.writeFileSync(file, value),
        outputFilePath: file => file,
        ipcMain: { handle: (_name, fn) => { favorite = fn; } },
      };
      vm.runInNewContext(section(source, 'function readStudioHistory(', 'function safeFileName(') + section(source, 'ipcMain.handle("set-video-favorite"', 'ipcMain.handle("app-version"'), context);
      for (const damaged of ['{truncated', 'null', '[]']) {
        fs.writeFileSync(historyFile, damaged);
        const result = favorite(null, path.join(root, 'output/i2v_old.mp4'), true);
        assert.equal(result.ok, false);
        assert.match(result.error, /读取视频历史失败/);
        assert.equal(fs.readFileSync(historyFile, 'utf8'), damaged);
      }
    });
    await check('thumbnail cache evicts old entries and enforces a size bound', async () => {
      const { createCoverCache } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/coverCache.mjs')).href);
      const cache = createCoverCache(3, 10);
      cache.set('a', '111'); cache.set('b', '222'); cache.set('c', '333');
      cache.get('a');
      cache.set('d', '444');
      assert.equal(cache.get('b'), undefined);
      assert.equal(cache.get('a'), '111');
      cache.set('d', '44444444');
      assert.equal(cache.size, 1);
      assert.ok(cache.characters <= 10);
      cache.set('oversized', 'x'.repeat(11));
      assert.equal(cache.get('oversized'), undefined);
    });
    assert.deepEqual(failures, []);
  } finally {
    assert.ok(isInside(os.tmpdir(), fixture) && path.basename(fixture).startsWith('h3-recovery-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
