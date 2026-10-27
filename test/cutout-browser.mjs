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
const output = fs.mkdtempSync(path.join(os.tmpdir(), "h3-cutout-ui-"));
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
  await page.getByRole("button", { name: /批量自动抠图/ }).click();
  assert.equal(await page.locator(".results-section, .composer").count(), 0);
  assert.equal(await page.getByRole("button", { name: "开始抠图", exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(output, "empty.png"), fullPage: true, animations: "disabled" });
  await page.locator(".cutout-source-frame").click();
  await page.waitForFunction(() => document.querySelector(".cutout-source-preview img")?.naturalWidth > 0);
  await page.getByRole("button", { name: "开始抠图", exact: true }).click();
  await page.waitForFunction(() => window.testJobs.length === 1);
  const submitted = await page.evaluate(() => window.testJobs[0]);
  assert.equal(submitted.workflow, "InspyrenetRembg抠图.json");
  assert.equal(submitted.media.length, 1);
  assert.equal(await page.locator(".cutout-source-preview img").count(), 1);
  await page.locator(".cutout-source-frame").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["test"], "replacement.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });
  await page.getByText("replacement.png", { exact: true }).waitFor();
  assert.equal(await page.locator(".cutout-source-preview img").count(), 2);
  assert.equal(await page.locator(".queue-link.active").count(), 0);
  await page.evaluate(() => window.nextFiles = ["C:/test/broken.png"]);
  await page.getByRole("button", { name: "替换图片", exact: true }).first().click();
  await page.getByText("无法预览，可尝试处理", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "开始抠图", exact: true }).isDisabled(), false);
  await page.evaluate(() => window.nextFiles = ["C:/test/repaired.png"]);
  await page.getByRole("button", { name: "替换图片", exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".cutout-broken-image").length === 0);
  assert.equal(await page.locator(".cutout-source-preview img").count(), 2);
  await page.getByRole("button", { name: "素材库", exact: true }).click();
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Delete");
  assert.equal(await page.evaluate(() => window.testJobs.length), 1);
  assert.equal(await page.locator(".cutout-source-card").count(), 2);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.testCutouts = [{ id: "sample", url: window.testImage, path: "C:/result.png", originalName: "一张用于验证完整预览及很长文件名换行表现的竖版人物图片.png", createdAt: Date.now(), size: 1234567 }];
    window.testEvents.onQueueCompleted({ workflowId: "cutout" });
  });
  await page.locator(".cutout-history-preview").first().waitFor();
  for (const [width, height, theme] of [[1800,1100,"light"],[1280,800,"light"],[1040,700,"light"],[2621,1607,"light"],[1280,800,"dark"]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    const layout = await page.evaluate(() => {
      const bounds = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right }; };
      return { source:bounds(".cutout-source-frame"), bench:bounds(".cutout-workbench"), run:bounds(".cutout-run"), history:bounds(".cutout-history"), overflow:document.documentElement.scrollWidth > innerWidth, fit:getComputedStyle(document.querySelector(".cutout-source-preview img")).objectFit };
    });
    assert.equal(layout.overflow, false);
    assert.equal(layout.fit, "contain");
    assert.ok(Math.abs(layout.source.width - layout.bench.width) < 2, "Upload pane must use the whole workbench");
    assert.ok(layout.run.bottom <= height, `Run button below viewport: ${width}x${height}`);
    assert.ok(layout.run.right <= width);
    assert.ok(layout.history.y > layout.run.bottom);
    await page.screenshot({ path: path.join(output, `${width}-${theme}.png`), fullPage: true, animations: "disabled" });
    console.log(`${width}x${height} ${theme}: layout passed`);
  }
  await page.locator(".cutout-history-preview").first().click();
  await page.locator(".cutout-preview-modal").waitFor();
  assert.ok(!(await page.locator(".cutout-preview-modal strong").textContent()).startsWith("@"));
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.locator(".cutout-history-copy button[title='删除结果']").click();
  await page.getByText("暂无记录", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.testCutouts = [{ id: 'locked', missingOutput: true, originalName: 'locked.png', createdAt: Date.now() }, { id: 'complete', url: window.testImage, originalName: 'complete.png', createdAt: Date.now() }];
    window.testEvents.onQueueCompleted({ workflowId: 'cutout' });
  });
  await page.locator('.cutout-missing-result').waitFor();
  assert.equal(await page.getByRole('button', { name: '预览 locked.png', exact: true }).isDisabled(), true);
  await page.locator('.cutout-history button[title="清空全部抠图记录"]').click();
  await page.getByText('测试：源图副本被占用，可重试删除', { exact: true }).waitFor();
  assert.equal(await page.locator('.cutout-history-item').count(), 1);
  await page.getByRole('button', { name: '删除 locked.png', exact: true }).click();
  await page.getByText('暂无记录', { exact: true }).waitFor();
  while (await page.getByRole("button", { name: "移除图片", exact: true }).count()) await page.getByRole("button", { name: "移除图片", exact: true }).first().click();
  assert.equal(await page.getByRole("button", { name: "开始抠图", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: /图生视频/ }).first().click();
  assert.equal(await page.locator(".composer").count(), 1);
  assert.equal(await page.locator(".results-section").count(), 1);
  await page.getByRole("button", { name: "＋ 添加", exact: true }).click();
  await page.locator(".prompt-preset-editor textarea").fill("快捷键只保存预设");
  await page.locator(".prompt-preset-editor textarea").press("Control+Enter");
  await page.getByRole("button", { name: "快捷键只保存预设", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.testVideos.length), 0, "Saving a preset must not generate a video");
  await page.getByRole("button", { name: /文生视频/ }).first().click();
  await page.locator(".composer > textarea").fill("保留输入的回归测试");
  await page.locator(".composer > textarea").press("Control+Enter");
  await page.waitForFunction(() => window.testVideos.length === 1);
  assert.equal(await page.locator(".composer > textarea").inputValue(), "保留输入的回归测试");
  assert.deepEqual(errors, []);
  console.log(`Browser checks passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
