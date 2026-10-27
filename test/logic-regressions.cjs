const assert = require('node:assert/strict');
const path = require('node:path');
const { savedVideoPaths } = require('../src/outputs.cjs');
const { outputSize, validateGenerationInputs } = require('../src/generation.cjs');

assert.deepEqual(outputSize({ aspectRatio: '1:1 (Square)', resolution: 'standard' }), [512, 512]);
assert.deepEqual(outputSize({ aspectRatio: '16:9 (Widescreen)', resolution: 'hd' }), [1344, 768]);
assert.deepEqual(outputSize({ aspectRatio: '9:16 (Portrait Widescreen)', resolution: 'ultra' }), [1088, 1920]);
const output = path.resolve('fixture/output');
const expected = path.join(output, 'video/own.mp4');
const graph = { save: { class_type: 'SaveVideo' }, preview: { class_type: 'PreviewImage' } };
const record = { outputs: {
  save: { images: [ { type: 'output', filename: 'own.mp4', subfolder: 'video' }, { type: 'output', filename: 'escape.mp4', subfolder: '../../' }, { type: 'temp', filename: 'temporary.mp4' } ] },
  preview: { images: [{ type: 'output', filename: 'unrelated.mp4' }] },
  otherJob: { images: [{ type: 'output', filename: 'other-job.mp4' }] },
} };
assert.deepEqual(savedVideoPaths(record, graph, output, () => true), [expected]);
assert.deepEqual(savedVideoPaths(record, graph, output, () => false), []);
assert.throws(() => validateGenerationInputs('r2v', []), /1 到 9/);
assert.throws(() => validateGenerationInputs('control', ['input.mp4'], { controlStrength: 3 }), /0 到 2/);
assert.throws(() => validateGenerationInputs('multiframe', ['1.png', '2.png'], { duration: 5, frameTimes: [1, 1.001] }), /递增/);
console.log('Logic regressions passed: output dimensions, prompt output ownership, required references, guide collisions and control range.');
