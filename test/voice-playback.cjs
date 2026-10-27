const assert = require('node:assert/strict');
const { evaluate } = require('./cdp-eval.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(expression, expected, label) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await evaluate(expression) === expected) return;
    await pause(70);
  }
  assert.equal(await evaluate(expression), expected, label);
}
async function main() {
  await evaluate('document.querySelector(".voice-link").click()');
  await check('document.querySelectorAll(".voice-select").length >= 2', true, 'Two existing audio samples are required');
  await evaluate('document.querySelectorAll(".voice-select")[0].click()');
  await check('!document.querySelector(".voice-listen audio").paused', true, 'First click must play immediately');
  await check('document.querySelectorAll(".voice-select")[0].getAttribute("aria-pressed")', 'true', 'Playing row must show pause');
  await evaluate('document.querySelectorAll(".voice-select")[0].click()');
  await check('document.querySelector(".voice-listen audio").paused', true, 'Second click must pause');
  await check('document.querySelectorAll(".voice-select")[0].getAttribute("aria-pressed")', 'false', 'Paused row must show play');
  await evaluate('document.querySelectorAll(".voice-select")[1].click()');
  await check('!document.querySelector(".voice-listen audio").paused', true, 'Unselected row must switch and play');
  await check('document.querySelectorAll(".voice-select")[1].getAttribute("aria-pressed")', 'true', 'Second row must own playback');
  await check('document.querySelectorAll(".voice-select[aria-pressed=true]").length', 1, 'Only one row can play');
  await evaluate('document.querySelector(".voice-listen audio").pause()');
  await check('document.querySelectorAll(".voice-select[aria-pressed=true]").length', 0, 'Player pause must update history');
  await evaluate('document.querySelector(".voice-listen audio").play()');
  await check('document.querySelectorAll(".voice-select")[1].getAttribute("aria-pressed")', 'true', 'Player play must update history');
  await evaluate('(()=>{const a=document.querySelector(".voice-listen audio");a.currentTime=a.duration-0.08;return true})()');
  await check('document.querySelector(".voice-listen audio").ended', true, 'Audio must finish naturally');
  await check('document.querySelectorAll(".voice-select[aria-pressed=true]").length', 0, 'End of playback must restore play icon');
  await evaluate('document.querySelectorAll(".voice-select")[1].click()');
  await check('!document.querySelector(".voice-listen audio").paused && !document.querySelector(".voice-listen audio").ended', true, 'Finished audio must replay');
  await evaluate('document.querySelectorAll(".voice-select")[0].click();document.querySelectorAll(".voice-select")[1].click();document.querySelectorAll(".voice-select")[0].click()');
  await check('document.querySelectorAll(".voice-select")[0].getAttribute("aria-pressed")', 'true', 'Rapid switching must follow last click');
  await evaluate('[...document.querySelectorAll("nav button")].find(b=>b.textContent.includes("图生视频")).click()');
  await check('document.querySelector(".voice-listen audio").paused', true, 'Leaving voice page must stop playback');
  await evaluate('document.querySelector(".voice-link").click()');
  console.log('Native history preview: click play/pause, source switching, shared player synchronization, end/replay, rapid clicks and navigation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
