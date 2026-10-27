import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const server = await createServer({cacheDir:'node_modules/.vite-edge-audit',server:{host:'127.0.0.1',port:0},plugins:[{name:'edge-audit',configureServer(s){s.middlewares.use('/__edge_audit',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__edge_audit','<html><body><div id="root"></div><script type="module" src="/test/ai-tools-harness.jsx"></script></body></html>'));});}}]});
let browser;
const failures=[];
try {
  await server.listen();
  browser=await chromium.launch({headless:true,...(process.env.H3_TEST_BROWSER_CHANNEL?{channel:process.env.H3_TEST_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:1450,height:1000}});
  await page.addInitScript(()=>{
    window.studio={getAiToolsState:async()=>({ready:true,models:{segment:true,understand:true,enhance:true,interpolate:true}}),onAiToolProgress:callback=>{window.emitAiProgress=callback;return ()=>{}},getPathForFile:f=>'C:/audit/'+f.name,runAiTool:async p=>{
      const previewUrl=document.querySelector('.ai-selection-image img')?.src;
      if(window.hold)await new Promise(resolve=>window.finish=resolve);
      if(window.failResult)return {ok:false,error:'自检模拟处理失败'};
      return p.kind==='segment'?{ok:true,resultPath:'C:/audit/result.png',previewUrl}:{ok:true,text:'旧任务结果'};
    }};
  });
  const fresh=async()=>{await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__edge_audit`);await page.locator('input[type=file]').setInputFiles(path.resolve('test/fixtures/upgrade-native-test.png'));await page.waitForFunction(()=>document.querySelector('.ai-selection-image img')?.naturalWidth>0);};
  const check=async(name,fn)=>{try{await fresh();await fn();console.log('PASS '+name);}catch(e){failures.push(name);console.error('FAIL '+name+': '+e.message);}};
  await check('failed retry restores the editable image',async()=>{
    await page.locator('.ai-selection-image').click();await page.locator('.ai-run-button').click();await page.waitForFunction(()=>document.querySelector('.show-result'));
    await page.evaluate(()=>window.failResult=true);await page.locator('.ai-run-button').click();await page.locator('.ai-tool-error').filter({hasText:'自检模拟处理失败'}).waitFor();
    assert.equal(await page.locator('.show-result').count(),0);
    await page.locator('.ai-selection-image').click();assert.match(await page.locator('.ai-segment-summary').textContent(),/2 个点击/);
  });
  await check('brush preview respects stroke order',async()=>{
    const box=await page.locator('.ai-selection-image').boundingBox();
    await page.getByRole('button',{name:'保留画笔',exact:true}).click();await page.mouse.click(box.x+box.width*.7,box.y+box.height*.7);
    await page.getByRole('button',{name:'擦除画笔',exact:true}).click();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.7);await page.mouse.down();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.7,{steps:10});await page.mouse.up();
    const pixel=await page.locator('.ai-segment-overlay').evaluate(async svg=>{
      const copy=svg.cloneNode(true);copy.setAttribute('xmlns','http://www.w3.org/2000/svg');copy.setAttribute('width','128');copy.setAttribute('height','128');
      const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(copy));await img.decode();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return Array.from(ctx.getImageData(90,90,1,1).data);
    });
    assert.ok(pixel[0]>pixel[1],`Newest erase stroke must appear red, got ${pixel}`);
  });
  await check('returning to a tool rejects results from its previous visit',async()=>{
    await page.locator('#sidebar-understand').click();await page.locator('input[type=file]').setInputFiles(path.resolve('test/fixtures/upgrade-native-test.png'));await page.evaluate(()=>window.hold=true);await page.locator('.ai-run-button').click();await page.waitForFunction(()=>typeof window.finish==='function');
    await page.locator('#sidebar-segment').click();await page.locator('#sidebar-understand').click();
    await page.evaluate(()=>window.finish());await page.waitForFunction(()=>!document.querySelector('input[type=file]').disabled);
    assert.equal(await page.locator('.ai-answer').count(),0);
  });
  await check('progress from another tool cannot replace the current task progress',async()=>{
    await page.locator('.ai-selection-image').click();await page.evaluate(()=>window.hold=true);
    await page.locator('.ai-run-button').click();await page.waitForFunction(()=>typeof window.finish==='function');
    await page.evaluate(async()=>{window.emitAiProgress({kind:'understand',label:'其他任务的进度',value:91});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    assert.equal((await page.locator('.ai-progress').textContent()).includes('其他任务的进度'),false);
    await page.evaluate(()=>window.emitAiProgress({kind:'segment',label:'当前抠图进度',value:37}));
    await page.getByText('当前抠图进度',{exact:true}).waitFor();
    await page.evaluate(()=>window.finish());await page.waitForFunction(()=>!document.querySelector('input[type=file]').disabled);
  });
  assert.deepEqual(failures,[]);
}finally{await browser?.close();await server.close();}
