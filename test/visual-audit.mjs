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
const output = "C:/Users/Administrator/Documents/Codex/2026-10-26/kokoro-82m-v1-1-zh/outputs/ui-audit-1.1.15"; fs.mkdirSync(output,{recursive:true});
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
    window.testEvents = {};
    window.testJobs = [];
    window.testCutouts = [];
    window.testVideos = [];
    window.nextFiles = ["C:/test/portrait.png"];
    window.savedPrefs = {};
    window.studio = new Proxy({
      getBackendUrl: async () => "http://127.0.0.1:8188",
      getEngineState: async () => ({ ready: true }),
      getAppVersion: async () => "1.0.4",
      loadPreferences: async (legacy) => ({ ok: true, values: legacy }),
      savePreference: async (key, value) => { window.savedPrefs[key] = value; return { ok: true }; },
      listVideos: async () => [],
      listQueue: async () => [],
      getAiToolsState:async()=>({ready:true,models:{enhance:true,interpolate:true,"image-enhance":true,segment:true,understand:true}}),
      getVoiceState:async()=>({ready:true,busy:false,engines:[{id:'kokoro',label:'Kokoro 中文',ready:true,voices:[{id:'zf_001',label:'中文女声 001'}]}]}),
      listVoices:async()=>[],
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

  const metrics=[];
  for(const [width,height,theme] of [[1800,1100,'light'],[1040,700,'light'],[1280,800,'dark']]) {
    await page.setViewportSize({width,height});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const title of ['图生视频','图片画质增强','智能抠图与分割','图像理解','语音合成','批量自动抠图','视频队列']) {
      await page.locator('.sidebar').getByRole('button',{name:title,exact:false}).click();
      if(title==='智能抠图与分割') await page.locator('.ai-tools-page input').setInputFiles(path.resolve('test/fixtures/upgrade-native-test.png'));
      await page.mouse.move(0,0);
      await page.waitForTimeout(180);
      await page.screenshot({path:path.join(output,`${width}-${theme}-${title}.png`),fullPage:true});
      metrics.push(await page.evaluate(({title,width,height,theme})=>({title,width,height,theme,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,activeCount:document.querySelectorAll('.sidebar .workflow-card.active').length,header:document.querySelector('.page-header').getBoundingClientRect().toJSON(),heading:document.querySelector('.content-heading').getBoundingClientRect().toJSON(),tools:document.querySelector('.page-tools').getBoundingClientRect().toJSON()}),{title,width,height,theme}));
    }
  }
  assert.ok(metrics.every(m=>m.activeCount===1 && m.scrollWidth<=m.width),'Single active navigation and no horizontal overflow');
  fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify(metrics,null,2));
  console.log(output);
} finally {await browser?.close();await server.close();}
