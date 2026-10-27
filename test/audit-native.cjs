const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluate } = require('./cdp-eval.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '../../../App');
const version = require('../package.json').version;
const marker = `Self audit ${version}`;
const picture = name => path.join(root, 'input', `self-audit-${name}.png`);
const source = path.join(__dirname, 'fixtures/upgrade-native-test.png');
const clickNav = label => evaluate(`[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`);
async function input(selector, value) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`);
  await pause(100);
}
const jobs = () => evaluate('window.studio.listQueue()');
async function cleanup() {
  for (const job of (await jobs()).filter(job => job.prompt === marker || job.originalPrompt === marker)) {
    await evaluate(`window.studio.cancelQueueItem(${JSON.stringify(job.id)})`);
    await evaluate(`window.studio.removeQueueItem(${JSON.stringify(job.id)})`);
  }
}
async function rowAction(id, action) {
  const index = (await jobs()).findIndex(job => job.id === id);
  assert.ok(index >= 0);
  await evaluate(`(()=>{const row=document.querySelectorAll('.queue-item')[${index}];const button=[...row.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(action)});if(!button)throw Error('Missing action');button.click();return true})()`);
  await pause(250);
}
async function main() {
  assert.equal(await evaluate('window.studio.getAppVersion()'), version);
  const wasPaused = await evaluate('window.studio.isQueuePaused()');
  await evaluate('window.studio.pauseQueue()');
  for (const name of ['a','b','c']) fs.copyFileSync(source, picture(name));
  try {
    const invalid = await evaluate(`window.studio.enqueue(${JSON.stringify({ workflow: 't2v', prompt: marker, settings: { seedMode: 'fixed', seed: '' } })})`);
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /Seed/);
    const seedJob = await evaluate(`window.studio.enqueue(${JSON.stringify({ workflow: 't2v', prompt: marker, settings: { seedMode: 'fixed', seed: 0 } })})`);
    assert.equal(seedJob.ok, true);
    assert.equal(seedJob.job.settings.seed, 0);
    await clickNav('视频队列');
    await pause(100);
    await rowAction(seedJob.job.id, '复用输入');
    await input('.generation-number', 2.9);
    assert.equal(await evaluate('document.querySelector(".generation-number").value'), '2');
    const before = (await jobs()).length;
    await evaluate('document.querySelector(".run-button").click()');
    for (let attempt = 0; attempt < 40 && (await jobs()).length < before + 2; attempt++) await pause(150);
    assert.equal((await jobs()).length, before + 2);
    assert.ok((await jobs()).filter(job => job.prompt === marker).every(job => job.settings.seed === 0));
    await cleanup();

    const result = await evaluate(`window.studio.enqueue(${JSON.stringify({ workflow: 'multiframe', prompt: marker, media: ['a','b','c'].map(picture), settings: { frameTimes: [0,1,2], duration: 5 } })})`);
    assert.equal(result.ok, true);
    await evaluate(`window.studio.cancelQueueItem(${JSON.stringify(result.job.id)})`);
    fs.unlinkSync(result.job.mediaPaths[1]);
    fs.unlinkSync(picture('b'));
    const damaged = (await jobs()).find(job => job.id === result.job.id);
    assert.equal(damaged.mediaPaths[1], '');
    assert.ok(damaged.mediaPaths[2]);
    await clickNav('视频队列');
    await pause(100);
    await rowAction(result.job.id, '重试');
    assert.match(await evaluate('document.querySelector(".queue-page [role=status]").textContent'), /素材已丢失/);
    await rowAction(result.job.id, '复用输入');
    assert.equal(await evaluate('document.querySelectorAll(".generation-input-item")[1].querySelector(".generation-media-preview") === null'), true);
    assert.ok(await evaluate('document.querySelectorAll(".generation-input-item")[2].textContent.includes("self-audit-c")'));
    assert.equal(await evaluate('document.querySelectorAll(".frame-time input")[2].value'), '2');
    assert.match(await evaluate('document.querySelector(".generation-feedback").textContent'), /1 个参考素材不可用/);

    fs.copyFileSync(source, picture('b'));
    await clickNav('视频队列');
    await pause(100);
    await rowAction(result.job.id, '重试');
    const recovered = (await jobs()).find(job => job.id === result.job.id);
    assert.equal(recovered.state, 'queued');
    assert.equal(recovered.mediaPaths.length, 3);
    assert.ok(recovered.mediaPaths.every(file => fs.existsSync(file)));
    await rowAction(recovered.id, '复用输入');
    await pause(500);
    await evaluate(`window.studio.cancelQueueItem(${JSON.stringify(recovered.id)})`);
    await evaluate(`window.studio.removeQueueItem(${JSON.stringify(recovered.id)})`);
    assert.ok(recovered.mediaPaths.every(file => fs.existsSync(file)), 'Removing a reused task must preserve its draft media');
    fs.writeFileSync(path.join(root, `logs/self-audit-native-${version}.json`), JSON.stringify({ version, fixedSeed: true, integerBatch: true, partialInputSlots: true, retryErrorsVisible: true, retryRecovery: true, draftInputsSurviveQueueRemoval: true }, null, 2));
    console.log('Packaged self audit passed: fixed seed, integer batch, missing input slots, retry errors and recovery.');
  } finally {
    await cleanup();
    for (const name of ['a','b','c']) { try { fs.unlinkSync(picture(name)); } catch (_) {} }
    if (!wasPaused) await evaluate('window.studio.resumeQueue()');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
