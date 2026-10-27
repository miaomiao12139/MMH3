const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const runtime = require('../src/runtime.cjs');
const { createPreferenceStore } = require('../src/preferences.cjs');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function main() {
  let failures = 0;
  const check = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (error) { failures++; console.error('FAIL', name, error.message); } };
  await check('task cancellation waits for acknowledgement and deduplicates backend requests',async()=>{
    let acknowledge;let calls=0;let closes=0;const task={promptId:'owned-prompt',canceled:false,ws:{close:()=>closes++}};const job={};
    const request=async(_method,route,body)=>{calls++;if(route==='/queue'){assert.equal(body.delete[0],'owned-prompt');await new Promise(resolve=>acknowledge=resolve)}};
    const first=runtime.cancelTask(request,task,job,'cancelRequested');const second=runtime.cancelTask(request,task,job,'cancelRequested');
    assert.equal(first,second);await tick();assert.equal(task.canceled,false);assert.equal(Boolean(job.cancelRequested),false);
    acknowledge();await Promise.all([first,second]);assert.equal(calls,2);assert.equal(closes,1);assert.equal(task.canceled,true);assert.equal(job.cancelRequested,true);
    assert.equal(task.cancellation,undefined);
  });
  await check('failed task cancellation can be retried and preparation cancellation kills only its task',async()=>{
    const task={promptId:'prompt',canceled:false};let fail=true;
    const request=async()=>{if(fail)throw Error('offline')};
    await assert.rejects(runtime.cancelTask(request,task),/offline/);assert.equal(task.canceled,false);assert.equal(task.cancellation,undefined);
    fail=false;await runtime.cancelTask(request,task);assert.equal(task.canceled,true);
    let kills=0;const preparation={canceled:false,preparation:{kill:()=>kills++}};
    await runtime.cancelTask(()=>{throw Error('must not request engine')},preparation);assert.equal(preparation.canceled,true);assert.equal(kills,1);
  });
  for (const kind of ['queue', 'ai', 'batch']) await check(`${kind}: rejected engine cancellation preserves task flags and reports failure`, async () => {
    const task = { promptId:'running-prompt', canceled:false, ws:{close(){throw Error('must not close socket')}} };
    const job = {id:'job',state:'running'}; const batch = {task,canceled:false}; const handlers = new Map();
    const context = { ...runtime, ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},readQueueJobs:()=>[job],activeQueueJobId:'job',activeTask:task,activeAiTool:task,activeCutoutBatch:batch,
      requestJson:async()=>{throw Error('engine unavailable')},emit(){},writeQueueJobs:()=>true,emitQueue(){} };
    const boundaries = kind === 'queue' ? ['ipcMain.handle("cancel-queue-item"','ipcMain.handle("remove-queue-item"'] : kind === 'ai' ? ['ipcMain.handle("cancel-ai-tool"','ipcMain.handle("list-voices"'] : ['ipcMain.handle("cancel-cutout-batch"','ipcMain.handle("list-queue"'];
    vm.runInNewContext(section(...boundaries), context);
    const handler = handlers.get(kind === 'queue' ? 'cancel-queue-item' : kind === 'ai' ? 'cancel-ai-tool' : 'cancel-cutout-batch');
    const result = await handler(null,'job');
    assert.equal(result.ok,false); assert.match(result.error,/engine unavailable/);
    assert.equal(task.canceled,false); assert.equal(Boolean(job.cancelRequested),false); assert.equal(batch.canceled,false);
  });
  for (const accepted of [true,false]) await check(`queue completion waits for ${accepted?'accepted':'rejected'} cancellation before classifying failure`,async()=>{
    const job={id:'one',workflowId:'t2v',state:'queued'};const handlers=new Map();let rejectWork,answerCancel;
    const context=vm.createContext({...runtime,queueWorkerPromise:null,queuePaused:false,backendReady:true,voiceService:null,activeAiTool:null,activeCutoutBatch:null,queueLoadError:'',activeQueueJobId:'',activeTask:{},queueProgressPersistAt:new Map(),
      readQueueJobs:()=>[job],writeQueueJobs:()=>true,writeQueuePaused:()=>true,emitQueue(){},emit(){},setJobProgress:(job,p)=>job.progress=p,publicQueueJob:j=>j,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},
      requestJson:async(_method,route)=>{if(route==='/queue')await new Promise((resolve,reject)=>answerCancel=()=>accepted?resolve():reject(Error('cancel rejected')))},
      runWorkflow:()=>{context.activeTask.promptId='owned-prompt';return new Promise((_,reject)=>rejectWork=reject)}});
    vm.runInContext(section('async function processQueue(','async function enqueueWorkflow(')+section('ipcMain.handle("cancel-queue-item"','ipcMain.handle("remove-queue-item"'),context);
    const work=context.processQueue();const stopping=handlers.get('cancel-queue-item')(null,'one');await tick();
    rejectWork(Error('engine stopped'));await tick();assert.equal(job.state,'running');
    answerCancel();assert.equal((await stopping).ok,accepted);await work;
    assert.equal(job.state,accepted?'cancelled':'failed');assert.equal(context.activeQueueJobId,'');
  });
  await check('late cancellation never clears a newer active task or emits its job ID',async()=>{
    const handlers=new Map();let acknowledge;const progress=[];const oldTask={promptId:'old-prompt',canceled:false};const nextTask={promptId:'next-prompt'};
    const context=vm.createContext({...runtime,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},activeQueueJobId:'old-job',activeTask:oldTask,
      readQueueJobs:()=>[{id:'old-job',state:'running'}],requestJson:async(_method,route)=>{if(route==='/queue')await new Promise(resolve=>acknowledge=resolve)},
      emit:(channel,value)=>{if(channel==='progress')progress.push(value)}});
    vm.runInContext(section('ipcMain.handle("cancel-workflow"','ipcMain.handle("open-output"'),context);
    const stopping=handlers.get('cancel-workflow')();await tick();context.activeTask=nextTask;context.activeQueueJobId='next-job';
    acknowledge();assert.equal(await stopping,true);assert.equal(context.activeTask,nextTask);assert.equal(progress[0].jobId,'old-job');
  });
  for (const race of ['retry', 'remove']) await check(`retry recovery racing with ${race} never starts a removed or duplicate task`, async () => {
    const handlers = new Map(); const gates=[]; let starts=0;
    const job={id:'one',state:'failed',media:['missing.png'],sourceMedia:['source.png'],outputPath:'old.mp4'}; const jobs=[job];
    const context={fs:{statSync:file=>{if(file==='missing.png')throw Error('missing');return {isFile:()=>true}},rmSync(){}},path,crypto,queueInputDir:id=>path.join('fixture',id),
      ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},readQueueJobs:()=>jobs,activeQueueJobId:'',writeQueueJobs:()=>true,emitQueue(){},cleanupQueueMedia(){},processQueue:()=>starts++,
      stageQueueMedia:()=>new Promise(resolve=>gates.push(resolve))};
    vm.runInNewContext(section('ipcMain.handle("remove-queue-item"','ipcMain.handle("clear-queue"'),context);
    const retry=handlers.get('retry-queue-item'); const first=retry(null,'one');
    assert.equal(gates.length,1);
    if(race==='retry') {
      const second=retry(null,'one'); assert.equal(gates.length,2);
      gates[0](['first.png']); await first; gates[1](['second.png']);
      assert.equal((await second).ok,false); assert.equal(job.media[0],'first.png'); assert.equal(starts,1);
    } else {
      assert.equal(handlers.get('remove-queue-item')(null,'one').ok,true);
      gates[0](['first.png']); assert.equal((await first).ok,false); assert.equal(starts,0); assert.equal(jobs.length,0);
    }
    await tick();
  });
  await check('failed asset-library deletion preserves displayed entries and skips file cleanup', async () => {
    const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/main.jsx'),'utf8');
    const start = renderer.indexOf('  const removeLibraryAssets =');
    let changes=0,cleanups=0; let status='';
    const remove = vm.runInNewContext(renderer.slice(start,renderer.indexOf('  const removeLibraryAsset =',start))+';removeLibraryAssets',{
      assetLibrary:[{id:'one',path:'keep.png'}],ASSET_LIBRARY_KEY:'minimax-h3-asset-library-v1',persistCurrentDraft(){},
      setAssetLibrary:()=>changes++,setStatus:value=>status=value,
      window:{studio:{savePreference:async()=>({ok:false,error:'disk full'}),pruneAssets:async()=>cleanups++}}});
    await remove([]); assert.equal(changes,0); assert.equal(cleanups,0); assert.match(status,/disk full/);
  });
  await check('malformed asset entries cannot be persisted or overwrite valid preferences', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'h3-preference-audit-'));
    try {
      const store=createPreferenceStore(()=>root,(file,text)=>fs.writeFileSync(file,text));store.load();
      const key='minimax-h3-asset-library-v1';store.save(key,'[{"id":"one","path":"keep.png"}]');
      const file=path.join(root,'user/studio-preferences.json');const original=fs.readFileSync(file,'utf8');
      for(const value of ['[null]','[1]','[{"path":12}]','[{"path":"a.png","name":{}}]']) assert.throws(()=>store.save(key,value),/素材库/);
      assert.equal(fs.readFileSync(file,'utf8'),original);
    } finally {fs.rmSync(root,{recursive:true,force:true})}
  });
  assert.equal(failures,0,`${failures} operational audit failures`);
}
main().catch(error=>{console.error(error);process.exitCode=1});
