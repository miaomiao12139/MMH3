import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false }, plugins: [{
  name: 'thumbnail-browser-harness',
  configureServer(vite) {
    vite.middlewares.use('/__thumbnail-audit', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml('/__thumbnail-audit', '<!doctype html><html><head><style>section,.video-preview-layer{width:320px;height:200px}video,img{width:320px;height:180px}</style></head><body><div id="root"></div><script type="module" src="/test/thumbnail-harness.jsx"></script></body></html>'));
    });
  },
}] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.H3_TEST_BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  const mediaRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('upgrade-native-test.mp4')) mediaRequests.push(request.url()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__thumbnail-audit`);
  await page.waitForSelector('#near img', { timeout: 10000 }).catch(async error => {
    console.error(JSON.stringify({ errors, mediaRequests, state: await page.evaluate(() => ({ text: document.body.innerText, videos: [...document.querySelectorAll('video')].map(video => ({ src: video.getAttribute('src'), ready: video.readyState, error: video.error?.message })) })) }));
    throw error;
  });
  assert.equal(await page.locator('#far video').getAttribute('src'), null);
  assert.ok(mediaRequests.every(url => !url.includes('?far')), 'Offscreen videos must not load');
  await page.locator('#far').scrollIntoViewIfNeeded();
  await page.waitForSelector('#far img');
  await page.waitForFunction(() => !document.querySelector('#near video').getAttribute('src'));
  assert.equal(await page.locator('#near img').count(), 0, 'Offscreen decoded covers must be released');
  assert.ok(mediaRequests.some(url => url.includes('?far')));
  await page.locator('#near').scrollIntoViewIfNeeded();
  await page.waitForSelector('#near img');
  await page.waitForFunction(() => !document.querySelector('#far video').getAttribute('src'));
  assert.deepEqual(errors, []);
  console.log('Thumbnail browser checks passed: offscreen loading blocked, visible videos decoded, offscreen media released, scrolling back restores cover.');
} finally {
  await browser?.close();
  await server.close();
}
