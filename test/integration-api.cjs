const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {Readable} = require('node:stream');
const source = fs.readFileSync(require('node:path').join(__dirname,'../src/main.cjs'),'utf8');
const invoked=[];
const registered=[...source.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map(m=>m[1]);
const context=vm.createContext({URL,Buffer,studioApiToken:'test',studioApiPort:18480,
  app:{getVersion:()=> '1.1.16'},backendReady:true,aiToolState:()=>({}),getVoiceService:()=>({state:()=>({}),list:()=>[]}),generationStyles:[],
  studioHandlers:new Map(registered.map(name=>[name,async(event,...args)=>{invoked.push({name,event,args});return {ok:true}}])),
  getIntegrationJobs:()=>({list:()=>[],submit:(kind,input,key)=>({id:'api-test',kind,input,key}),get:()=>null}),
});
vm.runInContext(source.slice(source.indexOf('const integrationActionHandlers ='),source.indexOf('async function startStudioApi()')),context);
async function request(method,url,body,auth='Bearer test'){
 const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);req.method=method;req.url=url;req.headers={authorization:auth,'idempotency-key':'test-key'};
 const res={writeHead(status){this.status=status},end(text){this.body=text?JSON.parse(text):null}};
 await context.handleStudioApi(req,res);return res;
}
(async()=>{
 let res=await request('GET','/api/v1/health',undefined,'');assert.equal(res.status,401);
 res=await request('GET','/api/v1/health');assert.equal(res.body.version,'1.1.16');
 res=await request('POST','/api/v1/actions',{action:'video.clear'});assert.equal(res.status,400);assert.equal(invoked.length,0);
 res=await request('POST','/api/v1/actions',{action:'video.clear',confirm:true,args:['t2v','records']});assert.equal(res.status,200);assert.equal(invoked[0].event.integration,true);
 res=await request('POST','/api/v1/actions',{action:'constructor',confirm:true});assert.equal(res.status,400);
 res=await request('POST','/api/v1/tasks',{kind:'voice',input:{text:'中文'}});assert.equal(res.status,202);assert.equal(res.body.job.key,'test-key');
 res=await request('GET','/api/v1/tasks/missing');assert.equal(res.status,404);
 res=await request('GET','/api/v1/openapi.json');assert.equal(res.status,200);
 for(const [route,methods] of Object.entries(res.body.paths)) for(const op of Object.values(methods)) {assert.ok(op.responses,route);if(route.includes('{id}'))assert.equal(op.parameters[0].required,true)}
 const actions=vm.runInContext('Object.values(integrationActionHandlers)',context);for(const name of actions)assert.ok(registered.includes(name),name);
 console.log('Integration HTTP passed: authentication, action confirmation, own-property allowlist, async submission, 404 and OpenAPI.');
})().catch(e=>{console.error(e);process.exitCode=1});
