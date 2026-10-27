const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { relocateStoredPaths, isInside } = require('../src/runtime.cjs');
const { validateGenerationInputs, resolveGenerationSettings } = require('../src/generation.cjs');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/main.jsx'), 'utf8');
const section = (text, start, end) => {
  assert.ok(text.includes(start) && text.includes(end), `Missing section ${start}`);
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
};

async function check() {
  assert.match(main, /filename_prefix = `video\/\$\{workflowId\}_MiniMax_H3_\$\{outputToken\}`/, 'Video output prefixes must be unique per task');
  for (const seed of ['', ' ', -1, 1.5, 'NaN', '9007199254740992']) assert.throws(() => validateGenerationInputs('t2v', [], { seedMode: 'fixed', seed }), /Seed/);
  validateGenerationInputs('t2v', [], { seedMode: 'fixed', seed: 0 });
  assert.equal(resolveGenerationSettings({ seedMode: 'fixed', seed: '0' }).seed, 0);
  const seeds = new Set(Array.from({ length: 16 }, () => resolveGenerationSettings({ seedMode: 'random', seed: '' }).seed));
  assert.ok(seeds.size > 1, 'Random jobs must not default to seed zero');
  for (const settings of [{ duration: -1 }, { resolution: 'broken' }, { style: 'missing' }, { aspectRatio: '4:3' }]) assert.throws(() => validateGenerationInputs('t2v', [], settings));

  const helpers = vm.runInNewContext(section(ui, 'function historyResolutionDisplay(', 'function syncVideoNativeAspect(') + ';({historyResolutionDisplay,batchCountValue})');
  assert.equal(helpers.batchCountValue(2.9), 2);
  assert.equal(helpers.historyResolutionDisplay({ resolution: 'standard' }), '标准');
  assert.equal(helpers.historyResolutionDisplay({ resolution: 'standard', width: 640, height: 640 }), '640 × 640');
  let activeProgress;
  const progressContext = { progressByJobRef: { current: new Map() }, syncComfyExecution() {}, progressClearTimerRef: { current: null }, setActiveProgress: value => { activeProgress = value; }, progressPercent: value => value.value, setQueueJobs() {} };
  const handleProgress = vm.runInNewContext(section(ui, '    const handleProgress = (value) => {', '    const removeProgress =') + ';handleProgress', progressContext);
  handleProgress({ jobId: 'retry', attempt: 1, value: 70 });
  handleProgress({ jobId: 'retry', attempt: 1, value: 60 });
  assert.equal(activeProgress.value, 70);
  handleProgress({ jobId: 'retry', attempt: 2, value: 3 });
  assert.equal(activeProgress.value, 3, 'Retry must start a new progress range');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-self-audit-'));
  try {
    const file = name => path.join(fixture, name);
    fs.writeFileSync(file('cached-a.png'), 'A');
    fs.writeFileSync(file('source-b.png'), 'B');
    const snapshot = vm.runInNewContext(section(main, 'function publicQueueJob(', 'function queueSnapshot(') + ';publicQueueJob', { fs, pathToFileURL });
    const inputs = { id: 'test', media: [file('cached-a.png'), file('missing-b.png')], sourceMedia: [file('missing-a.png'), file('source-b.png')] };
    assert.deepEqual(Array.from(snapshot(inputs).mediaPaths), [file('cached-a.png'), file('source-b.png')]);
    const holes = snapshot({ ...inputs, sourceMedia: [] });
    assert.deepEqual(Array.from(holes.mediaPaths), [file('cached-a.png'), '']);
    const refs = snapshot({ referenceAssets: [{ assetId: 'a', filePath: file('missing.png') }, { assetId: 'b', filePath: file('source-b.png') }] });
    assert.equal(refs.referenceAssets[0].filePath, '');
    assert.equal(refs.referenceAssets[0].previewUrl, '');
    assert.equal(refs.referenceAssets[1].assetId, 'b');
    assert.equal(refs.referenceAssets[1].filePath, file('source-b.png'));
    const missingOutput = snapshot({ state: 'completed', outputPath: file('gone.mp4'), outputPaths: [file('gone.mp4')] });
    assert.equal(missingOutput.outputMissing, true, 'Completed jobs with missing outputs must be marked');
    fs.writeFileSync(file('present.mp4'), 'video');
    const presentOutput = snapshot({ state: 'completed', outputPath: file('present.mp4'), outputPaths: [file('present.mp4')] });
    assert.equal(presentOutput.outputMissing, false, 'Existing completed outputs must stay available');
    let draftValues = {};
    const draftRoot = file('draft-root');
    const draftInput = path.join(draftRoot, 'user/queue-input/used/a.png');
    fs.mkdirSync(path.dirname(draftInput), { recursive: true });
    fs.writeFileSync(draftInput, 'draft input');
    const draftContext = { fs, path, fileURLToPath, relocateStoredPaths, isWithin: (base, target) => isInside(base, target), rootDir: () => draftRoot, queueInputDir: id => path.join(draftRoot, 'user/queue-input', id), preferences: { values: () => draftValues } };
    const drafts = vm.runInNewContext(section(main, 'function queueInputsUsedByDraft(', 'function pruneQueueInputDirs(') + section(main, 'function cleanupQueueMedia(', 'function freePort(') + ';({queueInputsUsedByDraft,cleanupQueueMedia})', draftContext);
    draftValues['minimax-h3-workflow-drafts-v1'] = JSON.stringify({ i2v: { files: [draftInput] } });
    drafts.cleanupQueueMedia({ id: 'used' });
    assert.ok(fs.existsSync(draftInput), 'Removing a queue row must keep its reused draft inputs');
    draftValues['minimax-h3-workflow-drafts-v1'] = '{}';
    drafts.cleanupQueueMedia({ id: 'used' });
    assert.equal(fs.existsSync(draftInput), false, 'Unreferenced queue inputs can be removed');

    let retry;
    let job;
    const context = { fs, path, crypto, pathToFileURL, queueInputDir: id => file(id), imageFilePattern: /\.(png|jpg)$/i,
      ipcMain: { handle: (_, callback) => { retry = callback; } }, readQueueJobs: () => [job], writeQueueJobs() {}, emitQueue() {}, processQueue() {} };
    vm.createContext(context);
    vm.runInContext(section(main, 'async function stageQueueMedia(', 'const imageFilePattern =') + section(main, 'function normalizeReferenceAsset(', 'function cleanupQueueMedia(') + section(main, 'ipcMain.handle("retry-queue-item"', 'ipcMain.handle("clear-queue"'), context);
    job = { ...inputs, state: 'failed', startedAt: 10, outputPaths: ['stale.mp4'] };
    assert.equal((await retry(null, 'test')).ok, true);
    assert.equal(job.state, 'queued');
    assert.equal(job.startedAt, 0);
    assert.equal(job.outputPaths.length, 0);
    assert.deepEqual(Array.from(job.media, p => fs.readFileSync(p, 'utf8')), ['A', 'B']);
    assert.ok(fs.existsSync(file('cached-a.png')));
    job = { ...inputs, id: 'failed-recovery', state: 'failed', sourceMedia: [] };
    assert.equal((await retry(null, job.id)).ok, false);
    assert.equal(job.state, 'failed');
    assert.ok(fs.existsSync(file('cached-a.png')), 'Failed recovery must preserve usable inputs');

    // Run the real submit handler with controlled IPC responses, without GPU work.
    const runSource = section(ui, '  const run = async () => {', '  return <div className="app-shell">');
    async function submit(settings, failAt = Infinity, workflow = 't2v') {
      let status = '';
      const submitted = [];
      const state = { runPendingRef: { current: false }, running: false, engineReady: true, current: { id: workflow, file: workflow, media: workflow === 'cutout' ? 1 : 0 }, files: workflow === 'cutout' ? ['a.png'] : [], referenceAssets: [], prompt: 'test', promptParts: [], settings, cutoutOptions: {}, randomSeed: () => 42, newAssetId: () => 'batch', batchCountValue: helpers.batchCountValue,
        setStatus: value => { status = value; }, setRunning() {}, setCutoutBatch() {}, setCutoutRecentResults() {}, rememberPrompt() {}, refreshQueue: async () => [], refreshCutouts: async () => [], queuePaused: true,
        window: { studio: { preflightWorkflow: async () => ({ ok: true }), enqueue: async payload => { if (submitted.length + 1 === failAt) return { ok: false, error: 'disk full' }; submitted.push(payload); return { ok: true }; }, runCutoutBatch: async () => ({ ok: false, canceled: true, total: 2, completed: 1, results: [] }) } } };
      const run = vm.runInNewContext(runSource + ';run', state);
      await run();
      assert.equal(state.runPendingRef.current, false);
      return { status, submitted };
    }
    assert.equal((await submit({ batchCount: 2.9 })).submitted.length, 2);
    const partial = await submit({ batchCount: 3 }, 2);
    assert.equal(partial.submitted.length, 1);
    assert.match(partial.status, /已加入 1 个任务.*disk full/);
    assert.match((await submit({}, Infinity, 'cutout')).status, /抠图已取消，完成 1\/2/);
    console.log('Self audit passed: seed validation, integer batches, partial submission, output labels, missing input slots, retry recovery and cutout cancellation.');
  } finally {
    assert.ok(path.dirname(fixture) === os.tmpdir() && path.basename(fixture).startsWith('h3-self-audit-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
check().catch(error => { console.error(error); process.exitCode = 1; });
