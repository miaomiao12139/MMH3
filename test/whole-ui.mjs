import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

// Optional visual/integration test: pass a Playwright installation and a sample PNG.
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const image = process.argv[3] ? `data:image/png;base64,${fs.readFileSync(process.argv[3]).toString("base64")}` : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
const output = process.env.H3_AUDIT_OUTPUT || path.join(os.tmpdir(), "h3-whole-ui"); fs.mkdirSync(output,{recursive:true});
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.H3_TEST_BROWSER_CHANNEL ? { channel: process.env.H3_TEST_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ image }) => {
    localStorage.clear();
    window.testEvents = {}; window.testVoices = [];
    window.testJobs = []; localStorage.setItem("minimax-h3-asset-library-v1", JSON.stringify([{id:"audit-asset",path:"C:/test/library.png",name:"自检素材",fileUrl:image}]));
    window.testCutouts = [];
    window.testVideos = [];
    window.nextFiles = ["C:/test/portrait.png"];
    window.savedPrefs = {};
    window.studio = new Proxy({
      getIntegrationInfo: async () => ({ok:true,appRoot:"Z:/MiniMax-H3-Studio/App",descriptorPath:"Z:/MiniMax-H3-Studio/App/user/studio-api.json",baseUrl:"http://127.0.0.1:18480"}),
      copyText:async text=>{window.copiedText=text;return {ok:true}},
      getBackendUrl: async () => "http://127.0.0.1:8188",
      getEngineState: async () => ({ ready: true }),
      getAppVersion: async () => "1.0.4",
      loadPreferences: async (legacy) => ({ ok: true, values: legacy }),
      savePreference: async (key, value) => { window.savedPrefs[key] = value; return { ok: true }; },
      listVideos: async () => [],
      listQueue: async () => [],
      getAiToolsState:async()=>({ready:true,models:{enhance:true,interpolate:true,"image-enhance":true,segment:true,understand:true}}),
      getVoiceState:async()=>({ready:true,busy:false,engines:[{id:'kokoro',label:'Kokoro 中文',ready:true,voices:[{id:'zf_001',label:'中文女声 001'}]}]}),
      listVoices:async()=>window.testVoices,
      getGenerationStyles: async () => [],
      listCutouts: async () => window.testCutouts,
      isQueuePaused: async () => false,
      pickFiles: async () => window.nextFiles,
      getPathForFile: (file) => `C:/test/${file.name}`,
      fileUrl: async (file) => file.includes("broken") ? "data:image/png;base64,INVALID" : image,
      stageAsset: async () => ({ ok: false }),
      preflightWorkflow: async () => ({ ok: true }),
      enqueue: async (payload) => { window.testVideos.push(payload); return { ok: true, position: 1 }; },
      runCutoutBatch: async (payload) => { window.testJobs.push(payload); return { ok: true, batchId: "batch", total: payload.media.length, completed: payload.media.length, failed: 0 }; },
      deleteCutout: async (id) => { window.testCutouts = window.testCutouts.filter((item) => item.id !== id); return { ok: true }; },
      clearCutouts: async () => { window.testCutouts = window.testCutouts.filter(item => item.id === 'locked'); return { ok: false, changed: true, error: '测试：源图副本被占用，可重试删除' }; },
    }, { get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith("on")) return (callback) => { window.testEvents[key] = callback; return () => {}; };
      return async () => ({});
    } });
    window.testImage = image;
  }, { image });
  await page.goto(`http://127.0.0.1:${port}`);



  await page.getByRole('button',{name:'素材库',exact:true}).click();
  await page.locator('.asset-library-item').waitFor();
  await page.evaluate(()=>window.studio.savePreference=async(key)=>key==='minimax-h3-asset-library-v1'?{ok:false,error:'模拟素材库保存失败'}:{ok:true});
  await page.locator('.asset-library-delete').click();
  await page.getByText('模拟素材库保存失败',{exact:true}).waitFor();
  assert.equal(await page.locator('.asset-library-item').count(),1);
  await page.evaluate(()=>window.studio.savePreference=async()=>({ok:true}));
  await page.locator('.asset-library-delete').click();
  await page.waitForFunction(()=>document.querySelectorAll('.asset-library-item').length===0);
  await page.keyboard.press('Escape');
  console.log('PASS library deletion preserves visible assets on save failure and removes them after successful persistence');

  await page.locator('.profile-trigger').click();
  await page.getByRole('button',{name:'CLI 与接口调用'}).click();
  const modal=page.getByRole('dialog',{name:'CLI 与接口调用'});
  assert.equal(await modal.locator('.integration-command').count(),0);
  await modal.getByRole('button',{name:'复制接入指令',exact:true}).click();
  assert.match(await page.evaluate(()=>window.copiedText),/全部本机功能/);
  assert.match(await page.evaluate(()=>window.copiedText),/h3 doctor/);
  await page.evaluate(()=>window.studio.copyText=async()=>({ok:false,error:'模拟剪贴板写入失败'}));
  await modal.locator('.integration-connect-copy').click();
  assert.equal(await modal.getByRole('status').innerText(),'');
  assert.match(await modal.getByRole('alert').innerText(),/模拟剪贴板/);
  await page.evaluate(()=>window.studio.copyText=async text=>{window.copiedText=text;return {ok:true}});
  await modal.locator('.integration-connect-copy').click();

  await page.screenshot({path:path.join(output,'simple-connect.png')});
  await modal.getByRole('button',{name:'高级说明',exact:true}).click();
  await modal.getByRole('button',{name:'复制连接当前 H3',exact:true}).click();
  assert.match(await page.evaluate(()=>window.copiedText),/Z:\/MiniMax-H3-Studio\/App/);
  assert.equal(await modal.getByRole('status').innerText(),'已复制到剪贴板');
  await modal.locator('select').selectOption('segment');
  await modal.getByRole('button',{name:'复制点选抠图 · PowerShell',exact:true}).click();
  assert.match(await page.evaluate(()=>window.copiedText),/segmentPrompts/);
  for(const [width,height,theme] of [[1280,800,'dark'],[1040,700,'light']]) {
    await page.setViewportSize({width,height});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.screenshot({path:path.join(output,`${theme}-cli.png`)});
    await modal.getByRole('tab',{name:'HTTP API'}).click();
    await modal.getByRole('button',{name:'复制鉴权与健康检查 · PowerShell',exact:true}).click();
    assert.match(await page.evaluate(()=>window.copiedText),/Get-Content/);
    const bounds=await modal.boundingBox(); assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.width<=width && bounds.height<=height);
    await page.screenshot({path:path.join(output,`${theme}-http.png`)});
    await modal.getByRole('tab',{name:'命令行 CLI'}).click();
  }
  await page.keyboard.press('Escape');assert.equal(await modal.count(),0);

  await page.setViewportSize({width:1280,height:800});
  const nav=page.locator('.workflow-card');
  const pages=['图生视频','参考生视频','文生视频','视频续接','多帧参考','控制视频','视频画质增强','视频补帧','图片画质增强','智能抠图与分割','图像理解','批量自动抠图','语音合成','视频队列'];
  for (const name of pages) {
    await nav.filter({hasText:name}).click();
    await page.getByRole('heading',{name,exact:true}).first().waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' horizontal overflow');
  }
  await nav.filter({hasText:'语音合成'}).click();
  await page.evaluate(()=>{
    window.testVoices=[{path:'C:/test/voice.wav',url:'',name:'voice.wav',text:'CLI 生成的语音',duration:1,sampleRate:24000,createdAt:Date.now(),speed:1,voice:'zf_001',engine:'kokoro'}];
    window.testEvents.onVoiceProgress({busy:false,stage:'idle',message:''});
  });
  await page.getByText('CLI 生成的语音',{exact:true}).waitFor();
  await page.evaluate(()=>window.studio.savePreference=async()=>({ok:false,error:'模拟磁盘已满'}));
  await page.getByRole('textbox',{name:'要朗读的文字'}).fill('自检草稿');
  await page.getByText('语音草稿保存失败：模拟磁盘已满',{exact:true}).waitFor();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('h3-preference-error',{detail:'模拟无写入权限'})));
  assert.ok((await page.locator('body').innerText()).includes('配置保存失败：模拟无写入权限'));
  await page.evaluate(()=>window.studio.savePreference=async()=>({ok:true}));
  await page.evaluate(()=>{
    window.pauseCalls=0;
    document.querySelector('audio').pause=()=>window.pauseCalls++;
    window.studio.deleteVoice=async()=>{window.testVoices=[];return {ok:true}};
  });
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('.voice-history-item button[title="删除语音"]').click();
  await page.waitForFunction(()=>window.pauseCalls>0 && !document.querySelector('.voice-history-item'));
  await nav.filter({hasText:'智能抠图与分割'}).click();
  await page.locator('.ai-file-drop input').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
  await page.getByRole('button',{name:'选中对象',exact:true}).waitFor();
  const canvas=page.locator('.ai-selection-image');
  await canvas.locator('img').evaluate(img=>img.decode());
  const bounds=await canvas.boundingBox();
  await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  assert.match(await page.locator('.ai-segment-summary').innerText(),/1 个点击/);
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  assert.match(await page.locator('.ai-segment-summary').innerText(),/0 个点击/);
  await page.getByRole('button',{name:'框选对象',exact:true}).click();
  await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.2);
  await page.mouse.down(); await page.mouse.move(bounds.x+bounds.width*.8,bounds.y+bounds.height*.8);await page.mouse.up();
  assert.match(await page.locator('.ai-segment-summary').innerText(),/已框选/);
  await page.screenshot({path:path.join(output,'segmentation.png')});
  console.log('PASS 14 page navigation, viewport overflow, external voice refresh, write failure feedback, click/box segmentation and undo');

  assert.deepEqual(errors,[]);
  console.log('UI verified: settings entry, command copying, sample selection, HTTP, light/dark layouts, Escape; no page errors.');
} finally {if(browser)await browser.close();await server.close();}
