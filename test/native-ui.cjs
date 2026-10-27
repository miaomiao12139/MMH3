const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluate } = require('./cdp-eval.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '../../../App');
const version = require('../package.json').version;
const marker = `Studio integration verification ${version}`;
const fixtureDir = path.join(__dirname, 'fixtures');
const testAssets = ['upgrade-native-test.png', 'upgrade-native-test.mp4'].map(name => ({
  target: path.join(root, 'input', name),
  source: path.join(fixtureDir, name),
}));
const stagedAssets = [];
const records = [];
async function main() {
  for (let i = 0; i < 180; i++) {
    if (await evaluate('(async()=> (await window.studio.getEngineState()).ready)()')) break;
    await pause(500);
  }
  assert.equal(await evaluate('window.studio.getAppVersion()'), version);
  assert.equal((await evaluate('window.studio.getGenerationStyles()')).length, 10);
  assert.equal(await evaluate('document.querySelectorAll("nav button").length'), 8);
  assert.equal(await evaluate('document.body.textContent.includes("官方新模板")'), false);
  const wasPaused = await evaluate('window.studio.isQueuePaused()');
  const preferenceSnapshot = await evaluate('window.studio.loadPreferences()');
  const draftSnapshot = preferenceSnapshot?.values?.['minimax-h3-workflow-drafts-v1'] || '';
  const queueInputRoot = path.join(root, 'user', 'queue-input');
  const initialQueueInputDirs = new Set(fs.existsSync(queueInputRoot)
    ? fs.readdirSync(queueInputRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : []);
  await evaluate('window.studio.pauseQueue()');
  try {
    for (const asset of testAssets) {
      if (!fs.existsSync(asset.target)) {
        fs.copyFileSync(asset.source, asset.target);
        stagedAssets.push(asset.target);
      }
    }
    const workflows = [ ['i2v', '图生视频', 2], ['r2v', '参考生视频', 1], ['t2v', '文生视频', 0], ['continuation', '视频续接', 1], ['multiframe', '多帧参考', 4], ['control', '控制视频', 1] ];
    for (const [id, name, count] of workflows) {
      const video = ['control', 'continuation'].includes(id);
      const media = Array.from({ length: count }, () => path.join(root, 'input', `upgrade-native-test.${video ? 'mp4' : 'png'}`));
      const payload = { workflow: id, prompt: marker, originalPrompt: marker, media, settings: { duration: 5, resolution: 'standard', aspectRatio: '16:9 (Widescreen)', samplingMode: 'turbo4', style: 'bullet_time', frameTimes: [0, 1, 2, 4], controlMode: 'pose', controlStrength: 0.7 } };
      if (id === 'r2v') payload.referenceAssets = [{ filePath: media[0], assetId: 'verification-image', type: 'image', index: 1 }];
      const result = await evaluate(`window.studio.enqueue(${JSON.stringify(payload)})`);
      assert.equal(result.ok, true, result.error);
      await evaluate('[...document.querySelectorAll("nav button")].find(b=>b.textContent.includes("视频队列")).click()');
      await pause(120);
      const queuedIndex = await evaluate(`window.studio.listQueue().then(items => items.findIndex(item => item.id === ${JSON.stringify(result.job.id)}))`);
      assert.ok(queuedIndex >= 0, `Missing queue row for ${name}`);
      await evaluate(`(()=>{const row=document.querySelectorAll('.queue-item')[${queuedIndex}];if(!row)throw new Error('Missing queue row');row.querySelector('.reuse').click();return true})()`);
      await pause(220);
      assert.equal(await evaluate('document.querySelector(".content h1").textContent'), name);
      assert.equal(await evaluate('document.querySelector("[aria-label=生成模式]").value'), 'turbo4');
      assert.equal(await evaluate('document.querySelector("[aria-label=特效风格]").value'), 'bullet_time');
      assert.equal(await evaluate('document.querySelector("[aria-label=特效风格]").options.length'), 11);
      if (id === 'multiframe') assert.equal(await evaluate('document.querySelectorAll(".frame-time input").length'), 4);
      if (video) assert.equal(await evaluate('document.querySelectorAll(".generation-media-preview video").length'), 1);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      if (id === 'multiframe') {
        await evaluate('document.querySelectorAll(".generation-input-actions")[1].querySelectorAll("button")[1].click()');
        await pause(100);
        assert.equal(await evaluate('document.querySelectorAll(".generation-input-item")[1].querySelector(".generation-media-preview") === null'), true);
        assert.equal(await evaluate('document.querySelectorAll(".generation-input-item")[2].querySelectorAll("img").length'), 1);
        assert.equal(await evaluate('document.querySelectorAll(".frame-time input")[2].value'), '2');
      }
      const before = (await evaluate('window.studio.listQueue()')).length;
      await evaluate('document.querySelector(".run-button").click()');
      let queue;
      for (let attempt = 0; attempt < 40; attempt++) {
        await pause(150);
        queue = await evaluate('window.studio.listQueue()');
        if (queue.length > before) break;
      }
      assert.equal(queue.length, before + 1, `${name}: native generate button enqueues; ${await evaluate('document.querySelector(".engine-status").textContent')}`);
      const job = queue[queue.length - 1];
      assert.equal(job.workflowId, id);
      assert.equal(job.state, 'queued');
      assert.equal(job.settings.style, 'bullet_time');
      assert.ok(await evaluate('document.querySelector(".generation-feedback").textContent.includes("队列已暂停")'));
      if (id === 'multiframe') assert.deepEqual(job.settings.frameTimes, [0, 2, 4]);
      records.push({ workflowId: id, reusedInputs: true, submittedFromUI: true, samplingMode: job.settings.samplingMode, style: job.settings.style });
      for (const item of queue.filter(j => j.originalPrompt === marker || j.prompt === marker)) {
        await evaluate(`window.studio.cancelQueueItem(${JSON.stringify(item.id)})`);
        await evaluate(`window.studio.removeQueueItem(${JSON.stringify(item.id)})`);
      }
    }
    fs.writeFileSync(path.join(root, `logs/native-ui-${version}.json`), JSON.stringify(records, null, 2));
    console.log(`Packaged Studio ${version}: 6 native modes, settings, input reuse and generation buttons passed.`);
  } finally {
    for (const item of (await evaluate('window.studio.listQueue()')).filter(j => j.originalPrompt === marker || j.prompt === marker)) {
      await evaluate(`window.studio.cancelQueueItem(${JSON.stringify(item.id)})`);
      await evaluate(`window.studio.removeQueueItem(${JSON.stringify(item.id)})`);
    }
    for (const file of stagedAssets) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
    if (draftSnapshot) {
      await evaluate(`window.studio.savePreference('minimax-h3-workflow-drafts-v1', ${JSON.stringify(draftSnapshot)})`);
      await pause(400);
    }
    if (fs.existsSync(queueInputRoot)) {
      for (const entry of fs.readdirSync(queueInputRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && !initialQueueInputDirs.has(entry.name)) {
          try { fs.rmSync(path.join(queueInputRoot, entry.name), { recursive: true, force: true }); } catch (_) {}
        }
      }
    }
    if (!wasPaused) await evaluate('window.studio.resumeQueue()');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
