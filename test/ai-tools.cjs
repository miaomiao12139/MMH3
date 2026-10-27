const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { savedVideoPaths } = require('../src/outputs.cjs');
const { cancelPrompt } = require('../src/runtime.cjs');
const { validateSegmentPrompts } = require('../src/segmentation.cjs');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const functionSource = source.slice(source.indexOf('async function runAiTool('), source.indexOf('\nasync function startBackend('));

async function exercise(kind, overrides = {}, options = {}) {
  const calls = [];
  let graph;
  class Socket extends EventEmitter {
    constructor() { super(); process.nextTick(() => this.emit('open')); }
    close() {}
  }
  const context = vm.createContext({
    backendReady: true, port: 8188, updateInProgress: false, activeQueueJobId: '', activeCutoutBatch: null,
    activeAiTool: null, voiceService: null, activeTask: {}, path, crypto: { randomUUID: () => 'audit-'+kind },
    fs: { existsSync: () => true, statSync: () => ({ size: options.size || 1000, isFile: () => true }), copyFileSync() {}, unlinkSync() {} },
    imageAssetPattern: /\.(png|jpe?g|webp|avif)$/i, aiToolState: () => ({ models: { [kind]: true } }),
    rootDir: () => path.resolve(__dirname, '../../../App'), emit() {}, processQueue() {},
    WebSocket: Socket, setTimeout, clearTimeout, savedVideoPaths, cancelPrompt, validateSegmentPrompts, pathToFileURL,
    isWithin: (base, file) => !path.relative(base, file).startsWith('..'),
    readWorkflowConfig: () => ({ ok: true, content: fs.readFileSync(path.join(__dirname,'../workflows/InspyrenetRembg抠图.json'),'utf8') }),
    describeEngineError: () => 'engine error',
    requestJson: async (method, route, payload) => {
      calls.push({ method, route, payload });
      if (route === '/prompt') { graph = payload.prompt; if (options.cancel) context.activeAiTool.canceled = true; return { prompt_id: 'audit-prompt' }; }
      if (route.startsWith('/history/')) { if (options.cancelDuringHistory) context.activeAiTool.canceled = true; return { 'audit-prompt': { status: { status_str: 'success' }, outputs: kind === 'understand' ? { 4: { text: [options.text ?? '一朵白花'] } } : (kind === 'segment' || kind === 'image-enhance') ? { 16: { images: [{ type: 'output',filename:'audit.png' }] } } : { 6: { videos: [{ type: 'output',filename:'audit.mp4' }] } } } }; }
      return {};
    },
  });
  vm.runInContext(functionSource, context);
  const result = await context.runAiTool({ kind, file: kind === 'understand' || kind === 'segment' || kind === 'image-enhance' ? 'audit.png' : 'audit.mp4', ...overrides });
  return { graph: JSON.parse(JSON.stringify(graph)), result, calls };
}

async function main() {
  const imageEnhance = await exercise('image-enhance');
  assert.equal(imageEnhance.graph['1'].class_type,'LoadImage');
  assert.equal(imageEnhance.graph['3'].class_type,'ImageUpscaleWithModel');
  assert.equal(imageEnhance.graph['4'].class_type,'SaveImage');
  assert.match(imageEnhance.result.previewUrl,/^file:/);
  await assert.rejects(exercise('image-enhance',{file:'video.mp4'}),/有效图片/);
  await assert.rejects(exercise('image-enhance',{}, {size:51*1024*1024}),/50 MB/);
  const enhance = await exercise('enhance');
  const interpolate = await exercise('interpolate', { multiplier: 3 });
  assert.equal(interpolate.graph['7'].inputs.expression, 'a * 3');
  assert.deepEqual(interpolate.graph['7'].inputs['values.a'], ['2',2]);
  assert.deepEqual(interpolate.graph['5'].inputs.fps, ['7',0]);
  assert.match(enhance.result.resultPath, /audit.mp4$/);
  const segment = await exercise('segment', { segmentMode: 'automatic', selection: { x: .25,y:.1,width:.5,height:.6,imageWidth:1000,imageHeight:500 } });
  assert.deepEqual(segment.graph.ai_crop.inputs, { image: ['14',0],width:500,height:300,x:250,y:50 });
  await assert.rejects(exercise('segment', { segmentMode: 'automatic', selection: {x:NaN} }), /框选/);
  const interactive = await exercise('segment', { segmentPrompts: {points:[{x:.3,y:.4,label:1},{x:.8,y:.6,label:0}],box:{x:.1,y:.1,width:.5,height:.7},strokes:[{label:0,radius:.03,points:[{x:.5,y:.5}]}]} });
  assert.equal(interactive.graph['2'].class_type, 'H3InteractiveSegment');
  assert.equal(JSON.parse(interactive.graph['2'].inputs.prompts).points.length, 2);
  assert.equal(JSON.parse(interactive.graph['2'].inputs.prompts).strokes[0].label, 0);
  assert.match(interactive.result.previewUrl, /^file:/);
  await assert.rejects(exercise('segment'), /请先点击/);
  assert.throws(()=>validateSegmentPrompts({points:[{x:Infinity,y:.5,label:1}]}), /点击选区/);
  assert.throws(()=>validateSegmentPrompts({box:{x:.9,y:0,width:.5,height:1}}), /框选/);
  assert.throws(()=>validateSegmentPrompts({points:[{x:.5,y:.5,label:0}]}), /请先点击/);
  assert.throws(()=>validateSegmentPrompts({strokes:[{label:1,radius:1,points:[{x:.5,y:.5}]}]}), /画笔/);
  await assert.rejects(exercise('understand', {}, { size: 51*1024*1024 }), /50 MB/);
  await assert.rejects(exercise('interpolate', {multiplier:2.5}), /倍率/);
  await assert.rejects(exercise('understand', {}, { text:',,,,,，' }), /只有标点/);
  await assert.rejects(exercise('segment', {segmentMode:'automatic'}, { cancel:true }), /取消/);
  await assert.rejects(exercise('understand', {}, { cancelDuringHistory:true }), /取消/);
  const understand = await exercise('understand');
  assert.equal(understand.graph['2'].inputs.clip_name,'qwen3vl_4b_fp8_scaled.safetensors');
  if (process.argv.includes('--graphs')) console.log(JSON.stringify({enhance:enhance.graph,interpolate:interpolate.graph,segment:segment.graph,interactive:interactive.graph,understand:understand.graph}));
  else console.log('AI tools passed: multiplied source FPS, video output variants, crop bounds, image limit, invalid text and cancellation.');
}
main().catch(error => {console.error(error); process.exitCode=1;});
