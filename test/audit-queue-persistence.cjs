const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../src/main.cjs'),'utf8');
const code = source.slice(source.indexOf('async function processQueue('),source.indexOf('\nasync function enqueueWorkflow('));
async function exercise(failAt) {
  let writes=0,started=0;
  const job={id:'audit-job',workflowId:'t2v',state:'queued'};
  const context=vm.createContext({queueWorkerPromise:null,queuePaused:false,backendReady:true,voiceService:null,activeAiTool:null,activeCutoutBatch:null,queueLoadError:'',activeQueueJobId:'',activeTask:{},queueProgressPersistAt:new Map(),
    readQueueJobs:()=>[job],writeQueueJobs:()=>++writes!==failAt,writeQueuePaused:()=>true,emitQueue(){},emit(){},setJobProgress:(job,p)=>job.progress=p,publicQueueJob:j=>j,
    runWorkflow:async()=>{started++;return {outputPath:'audit.mp4'};},Date});
  vm.runInContext(code,context);await context.processQueue();
  return {started,job,context};
}
(async()=>{
  for(const failAt of [1,2]){
    const r=await exercise(failAt);assert.equal(r.started,0,'Never start GPU work when task state cannot be saved');assert.equal(r.job.state,'queued');assert.equal(r.context.activeQueueJobId,'');assert.equal(r.context.queuePaused,true);
  }
  const completed=await exercise(3);assert.equal(completed.started,1);assert.equal(completed.job.state,'completed');assert.equal(completed.context.queuePaused,true,'Pause further jobs if completion cannot be saved');
  for (const persisted of [false,true]) {
    let handler, started=0;
    const context=vm.createContext({queuePaused:true,writeQueuePaused:()=>persisted,processQueue:()=>started++,emitQueue(){},ipcMain:{handle:(_name,fn)=>handler=fn}});
    vm.runInContext(source.slice(source.indexOf('ipcMain.handle("resume-queue"'),source.indexOf('ipcMain.handle("cancel-queue-item"')),context);
    const result=handler();
    assert.equal(result.ok,persisted);
    assert.equal(context.queuePaused,!persisted);
    assert.equal(started,persisted?1:0,'Never resume generation when the pause state cannot be persisted');
  }
  console.log('Queue persistence passed: failed preparation/running writes block generation, failed completion write pauses queue.');
})().catch(e=>{console.error(e);process.exitCode=1;});
