const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createIntegrationJobs } = require('../src/integration-jobs.cjs');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-concurrency-'));
  let failed = 0;
  const check = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (error) { failed++; console.error('FAIL', name, error.message); } };
  try {
    for (const action of ['remove', 'clear', 'reorder', 'retry', 'cancel']) await check(`${action} rolls back on failed queue persistence, without deleting inputs or starting work`, async () => {
      const handlers = new Map(); const cleanups = []; let starts = 0;
      const jobs = [{ id: 'one', state: action === 'retry' ? 'failed' : action === 'clear' ? 'completed' : 'queued', error: 'original', media: [], sourceMedia: [], outputPath: 'preserve.mp4' }, { id: 'two', state: 'queued' }];
      const original = JSON.stringify(jobs);
      const context = { fs, path, crypto, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, readQueueJobs: () => jobs,
        writeQueueJobs: () => false, cleanupQueueMedia: job => cleanups.push(job.id), emitQueue() {}, processQueue: () => starts++, activeQueueJobId: '', activeTask: {}, queuePaused: true,
        readQueueRetentionDays: () => 7, writeQueueRetentionDays() {}, writeQueuePaused: () => true };
      vm.runInNewContext(section('ipcMain.handle("reorder-queue-item"', 'ipcMain.handle("run-workflow"'), context);
      const args = action === 'clear' ? ['all'] : action === 'reorder' ? ['one', 1] : ['one'];
      const result = await handlers.get(`${action}-queue${action === 'clear' ? '' : '-item'}`)(null, ...args);
      assert.equal(result.ok, false);
      assert.equal(JSON.stringify(jobs), original);
      assert.equal(cleanups.length, 0);
      assert.equal(starts, 0);
    });
    await check('successful removal persists the new queue before cleaning inputs', async () => {
      const handlers = new Map(); const events = []; const jobs = [{id:'one',state:'completed'}];
      vm.runInNewContext(section('ipcMain.handle("remove-queue-item"', 'ipcMain.handle("retry-queue-item"'), {
        ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},readQueueJobs:()=>jobs,activeQueueJobId:'',
        writeQueueJobs:()=>{events.push('saved');assert.equal(jobs.length,0);return true},
        cleanupQueueMedia:()=>events.push('cleanup'),emitQueue:()=>events.push('emit') });
      assert.equal(handlers.get('remove-queue-item')(null,'one').ok,true);
      assert.deepEqual(events,['saved','cleanup','emit']);
    });
    await check('cancellation failure racing with task success preserves completed status', async () => {
      const folder = path.join(root, 'cancel'); let finish, rejectCancel;
      const jobs = createIntegrationJobs({ rootDir: () => folder, writeText: (p,t) => fs.writeFileSync(p,t), isBusy: () => false,
        operations: { test: () => new Promise(resolve => finish = resolve) }, cancel: () => new Promise((_,reject) => rejectCancel = reject) });
      const first = jobs.submit('test', {});
      const stopping = jobs.stop(first.id); const rejection = assert.rejects(stopping, /network failed/);
      finish({ ok: true }); await tick(); rejectCancel(Error('network failed')); await rejection; await tick();
      assert.equal(jobs.get(first.id).state, 'completed');
      const stored = JSON.parse(fs.readFileSync(path.join(folder, 'user/integration-jobs.json')));
      assert.equal(stored[0].state, 'completed');
      assert.equal(jobs.busy, false);
    });
    await check('duplicate cancellation requests share one backend operation', async () => {
      const folder = path.join(root, 'double'); let finish, acceptCancel; let calls = 0;
      const cancellation = new Promise(resolve => acceptCancel = resolve);
      const jobs = createIntegrationJobs({ rootDir: () => folder, writeText: (p,t) => fs.writeFileSync(p,t), isBusy: () => false,
        operations: { test: () => new Promise(resolve => finish = resolve) }, cancel: () => { calls++; return cancellation; } });
      const first = jobs.submit('test', {});
      const a = jobs.stop(first.id), b = jobs.stop(first.id);
      acceptCancel({ ok: true }); await Promise.all([a,b]); finish({ ok: true }); await tick();
      assert.equal(calls, 1);
      assert.equal(jobs.get(first.id).state, 'cancelled');
    });
    await check('synchronous cancellation failure permits a subsequent cancellation attempt', async () => {
      const folder = path.join(root, 'sync-cancel'); let finish; let calls = 0;
      const jobs = createIntegrationJobs({ rootDir: () => folder, writeText: (p,t) => fs.writeFileSync(p,t), isBusy: () => false,
        operations: { test: () => new Promise(resolve => finish = resolve) }, cancel: () => { if (++calls === 1) throw Error('temporary failure'); return { ok: true }; } });
      const first = jobs.submit('test', {});
      await assert.rejects(jobs.stop(first.id), /temporary failure/);
      await jobs.stop(first.id); finish({ ok: true }); await tick();
      assert.equal(calls, 2); assert.equal(jobs.get(first.id).state, 'cancelled');
    });
    await check('restoring a backup from another workflow cannot overwrite the selected workflow', async () => {
      const folder = path.join(root, 'backups'); const backupDir = path.join(folder, 'user/workflows/backups'); fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, 'i2v.example.json'), '{"source":"image-workflow"}');
      const target = path.join(folder, 't2v.json'); fs.writeFileSync(target, '{"source":"text-workflow"}');
      let restore; const context = { fs, path, rootDir: () => folder, ipcMain: { handle: (_, fn) => restore = fn },
        workflowIdFromValue: value => value, isWithin: (parent, child) => child.startsWith(parent + path.sep),
        validateWorkflowGraph: () => '', customWorkflowPath: () => target, workflowBackupPath: () => path.join(folder, 'previous.json'),
        atomicWriteText: (file, text) => fs.writeFileSync(file, text) };
      vm.runInNewContext(section('ipcMain.handle("restore-workflow-backup"', 'ipcMain.handle("export-config"'), context);
      assert.equal(restore(null, 't2v', 'i2v.example.json').ok, false);
      assert.equal(JSON.parse(fs.readFileSync(target)).source, 'text-workflow');
      fs.writeFileSync(path.join(backupDir, 't2v.example.json'), '{"source":"correct-backup"}');
      assert.equal(restore(null, 't2v', 't2v.example.json').ok, true);
      assert.equal(JSON.parse(fs.readFileSync(target)).source, 'correct-backup');
    });
    await check('damaged semantic task history is rejected repeatedly and preserved', async () => {
      const folder = path.join(root, 'history'); fs.mkdirSync(path.join(folder, 'user'), { recursive: true });
      const file = path.join(folder, 'user/integration-jobs.json');
      for (const invalid of [[{id:'duplicate',kind:'test',state:'completed'},{id:'duplicate',kind:'test',state:'completed'}],
        [{id:'one',kind:'test',state:'unknown'}],[{id:'one',state:'completed'}],[{id:'',kind:'test',state:'completed'}]]) {
        const raw = JSON.stringify(invalid); fs.writeFileSync(file, raw);
        const jobs = createIntegrationJobs({ rootDir: () => folder, writeText: (p,t) => fs.writeFileSync(p,t), operations: {}, isBusy: () => false });
        assert.throws(() => jobs.list(), /损坏/); assert.throws(() => jobs.list(), /损坏/); assert.equal(fs.readFileSync(file,'utf8'), raw);
      }
    });
  } finally { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); }
  assert.equal(failed, 0, `${failed} audit failures`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
