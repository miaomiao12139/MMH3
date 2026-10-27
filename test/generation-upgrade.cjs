const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applyGenerationSettings, bindGenerationInputs, styledPrompt, validateGenerationInputs, styles } = require('../src/generation.cjs');
const cases = [];
const files = { i2v: '图生视频', t2v: '文生视频', r2v: '参考生视频', continuation: '视频续接', multiframe: '多帧参考', control: '控制视频' };
for (const [workflowId, label] of Object.entries(files)) {
  for (const samplingMode of ['quality', 'turbo4', ...(['i2v', 't2v', 'continuation'].includes(workflowId) ? ['turbo8'] : [])]) {
    for (const controlMode of workflowId === 'control' ? ['pose', 'direct'] : ['pose']) {
      const graph = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows', `MiniMax-H3-${label}.json`), 'utf8'));
      const settings = { duration: 5, resolution: 'standard', samplingMode, controlMode, frameTimes: [0, 1, 2, 4], controlStrength: 0.7 };
      const count = workflowId === 'multiframe' ? 4 : workflowId === 'i2v' ? 2 : ['continuation', 'control'].includes(workflowId) ? 1 : 0;
      const uploaded = Array.from({ length: count }, () => ({ filename: workflowId === 'control' ? 'upgrade-native-test.mp4' : 'upgrade-native-test.png' }));
      if (['i2v', 'continuation', 'multiframe', 'control'].includes(workflowId)) {
        validateGenerationInputs(workflowId, Array.from({ length: count }, () => workflowId === 'continuation' || workflowId === 'control' ? 'input.mp4' : 'input.png'), settings);
        bindGenerationInputs(graph, workflowId, uploaded, settings);
      }
      applyGenerationSettings(graph, workflowId, settings);
      applyGenerationSettings(graph, workflowId, settings); // queue snapshot and execution must agree.
      const h3 = Object.values(graph).find(n => n.class_type === 'MiniMaxH3ImageToVideo' || n.class_type === 'MiniMaxH3ReferenceToVideo');
      h3.inputs.prompt = 'A quiet landscape';
      if (workflowId === 'r2v') for (const n of Object.values(graph)) if (n.class_type === 'LoadImage') n.inputs.image = 'upgrade-native-test.png';
      const ids = new Set(Object.keys(graph));
      for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(ids.has(String(value[0])), `Dangling connection ${value[0]}`);
      const steps = Object.values(graph).find(n => n.class_type === 'ComfySwitchNode' && graph[n.inputs.on_true?.[0]]?.class_type === 'PrimitiveInt');
      assert.equal(steps.inputs.switch, samplingMode !== 'quality');
      assert.equal(graph[steps.inputs[samplingMode === 'quality' ? 'on_false' : 'on_true'][0]].inputs.value, samplingMode === 'quality' ? 20 : samplingMode === 'turbo4' ? 4 : 8);
      if (workflowId === 'i2v') assert.ok(h3.inputs.first_frame && h3.inputs.last_frame);
      if (workflowId === 'multiframe') assert.deepEqual(Object.values(graph).filter(n => n.class_type === 'MiniMaxH3AddGuide').map(n => n.inputs.frame_idx), [0, 24, 48, 96]);
      if (workflowId === 'control') assert.equal(Object.values(graph).find(n => n.class_type === 'MiniMaxH3FunControlNetApply').inputs.strength, 0.7);
      cases.push({ workflowId, samplingMode, controlMode, graph });
    }
  }
}
assert.throws(() => validateGenerationInputs('multiframe', ['a.png', 'b.png'], { duration: 5, frameTimes: [3, 1] }), /递增/);
assert.throws(() => validateGenerationInputs('control', ['a.png']), /视频/);
assert.throws(() => applyGenerationSettings({}, 'i2v', { samplingMode: 'turbo4', resolution: 'ultra' }), /768p/);
assert.equal(styles.length, 10);
assert.match(styledPrompt('hello', 'bullet_time'), /^embedding:minimaxh3_bullet_time.safetensors hello$/);
const destination = process.argv[2];
if (destination) fs.writeFileSync(destination, JSON.stringify(cases, null, 2));
console.log(`${cases.length} generation combinations passed: quality/turbo, first/last frames, timed guides, pose/direct control, style and input validation.`);
