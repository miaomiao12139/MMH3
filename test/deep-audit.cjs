const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createPreferenceStore } = require('../src/preferences.cjs');
const { describeEngineError } = require('../src/runtime.cjs');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/main.jsx'), 'utf8').replace(/\r\n/g, '\n');
const slice = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

async function main() {
  const { normalizeStudioConfig } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/studioConfig.mjs')).href);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-deep-audit-'));
  try {
    const root = path.join(fixture, 'App');
    fs.mkdirSync(path.join(root, 'user'), { recursive: true });
    const file = path.join(root, 'user/studio-preferences.json');
    for (const original of ['null', 'false', '0', '[]']) {
      fs.writeFileSync(file, original);
      const preferences = createPreferenceStore(() => root, (p, text) => fs.writeFileSync(p, text));
      assert.throws(() => preferences.load());
      preferences.flush();
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    }
    for (const values of [
      { 'minimax-h3-asset-copies-v1': '{}' },
      { 'minimax-h3-workflow-drafts-v1': '{"i2v":{"files":42}}' },
      { 'minimax-h3-profile': '{"name":42}' },
    ]) {
      const original = JSON.stringify({ runtimeRoot: root, values });
      fs.writeFileSync(file, original);
      const preferences = createPreferenceStore(() => root, (p, text) => fs.writeFileSync(p, text));
      assert.throws(() => preferences.load());
      preferences.flush();
      assert.throws(() => preferences.save('minimax-h3-theme', 'light'));
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'Invalid nested settings must not be replaced after a failed load');
    }
    const valid = { version: 2, profile: { name: 'User', avatar: '' }, workflowDrafts: { i2v: { files: ['a.png'], previews: [], prompt: 'saved', settings: { duration: 8 } }, control: { files: ['a.mp4'], settings: { controlMode: 'direct' } } }, cutoutOptions: { format: 'webp', batchFolder: false }, audioMuted: false, notificationsEnabled: true };
    const restored = normalizeStudioConfig(valid);
    assert.equal(restored.workflowDrafts.i2v.settings.duration, 8);
    assert.equal(restored.workflowDrafts.control.settings.controlMode, 'direct');
    assert.equal(restored.cutoutOptions.format, 'webp');
    assert.equal(normalizeStudioConfig({ version: 1, settings: { duration: 5 } }).settings.duration, 5);
    for (const invalid of [{ version: 2, profile: { name: 42 } }, { version: 2, promptPresets: [null] }, { version: 2, workflowDrafts: { i2v: { files: 42 } } }, { version: 2, settings: { duration: 99 } }]) assert.throws(() => normalizeStudioConfig(invalid), /未应用任何更改/);
    let setters = 0;
    let status = '';
    const context = { runPendingRef: { current: false }, window: { studio: { importConfig: async () => ({ ok: true, payload: { version: 2, profile: { name: 42 } } }) } }, normalizeStudioConfig, setStatus: value => { status = value; }, setProfile: () => { setters++; } };
    const restore = vm.runInNewContext(slice(renderer, '  const importStudioConfig = async () => {', '  useEffect(() => {\n    if (!window.studio)') + ';importStudioConfig', context);
    await restore();
    assert.equal(setters, 0);
    assert.match(status, /未应用任何更改/);
    const applied = {};
    Object.assign(context, { current: { id: 'i2v' }, DEFAULT_SETTINGS: {}, WORKFLOW_DRAFTS_KEY: 'drafts', workflowDraftsRef: { current: {} }, persistValue: (key, value) => { applied[key] = value; } });
    for (const key of ['Files', 'Previews', 'Prompt', 'PromptParts', 'ReferenceAssets', 'Settings', 'CutoutOptions', 'AudioMuted', 'NotificationsEnabled']) context[`set${key}`] = value => { applied[key] = value; };
    context.window.studio.importConfig = async () => ({ ok: true, payload: valid });
    await restore();
    assert.deepEqual(Array.from(applied.Files).filter(Boolean), ['a.png']);
    assert.equal(applied.Settings.duration, 8);
    assert.equal(applied.AudioMuted, false);
    assert.equal(context.workflowDraftsRef.current.control.settings.controlMode, 'direct');
    let exported;
    const exporter = vm.runInNewContext(slice(renderer, '  const exportStudioConfig = async () => {', '  const importStudioConfig = async () => {') + ';exportStudioConfig', {
      profile: valid.profile, theme: 'light', promptHistory: {}, promptPresets: [], assetLibrary: [], videoFavorites: [], settings: {},
      workflowDraftsRef: { current: valid.workflowDrafts }, current: { id: 'i2v' }, currentDraft: () => valid.workflowDrafts.i2v,
      cutoutOptions: valid.cutoutOptions, audioMuted: false, notificationsEnabled: true, setStatus() {},
      window: { studio: { exportConfig: async payload => { exported = payload; return { ok: true }; } } },
    });
    await exporter();
    assert.equal(exported.version, 2);
    assert.equal(exported.workflowDrafts.control.settings.controlMode, 'direct');
    assert.equal(exported.cutoutOptions.format, 'webp');

    assert.match(describeEngineError({ error: { message: 'Validation failed' }, node_errors: { 1: { class_type: 'UNETLoader', errors: [{ message: 'Value not in list', details: 'missing.safetensors' }] } } }), /UNETLoader.*missing.safetensors/);
    assert.match(describeEngineError({ status: { messages: [['execution_error', { node_type: 'Sampler', exception_message: 'CUDA out of memory' }]] } }), /Sampler.*CUDA out of memory/);
    const runSource = slice(source, 'async function runWorkflow(', 'const queueWorkflowNames =');
    async function simulate(kind) {
      const canceled = [];
      let histories = 0;
      const run = vm.runInNewContext(runSource + ';runWorkflow', { activeAiTool: null, voiceService: null,
        fs, path, crypto, rootDir: () => root, applyGenerationSettings() {}, styledPrompt: text => text, outputSize: () => [32,32], isDurationNode: () => false,
        activeTask: null, clientId: 'client', port: 1, WebSocket: class { constructor() { throw new Error('No socket'); } },
        setTimeout: callback => { callback(); return 1; }, clearTimeout() {}, reportProgress() {}, describeEngineError, emit() {},
        cancelPrompt: async (_, id) => { canceled.push(id); },
        workflowIdFromValue: () => 't2v', requestJson: async (_, route) => {
          if (route === '/prompt') return kind === 'missing-id' ? {} : { prompt_id: 'own-prompt' };
          histories++;
          if (kind === 'failure') return { 'own-prompt': { status: { status_str: 'error', messages: [['execution_error', { node_type: 'Sampler', exception_message: 'CUDA out of memory' }]] } } };
          return {};
        },
      });
      await assert.rejects(run(null, { workflow: 't2v', prompt: 'test', media: [], workflowGraph: { 1: { class_type: 'RandomNoise', inputs: {} } } }), kind === 'timeout' ? /等待超时/ : kind === 'missing-id' ? /未返回任务编号/ : /CUDA out of memory/);
      return { canceled, histories };
    }
    assert.deepEqual((await simulate('timeout')).canceled, ['own-prompt']);
    assert.deepEqual((await simulate('failure')).canceled, []);
    assert.equal((await simulate('missing-id')).histories, 0);
    console.log('Deep audit passed: transactional preferences, config validation/roundtrip, detailed engine errors, missing prompt IDs and timeout cancellation.');
  } finally {
    assert.equal(path.dirname(fixture), os.tmpdir());
    assert.ok(path.basename(fixture).startsWith('h3-deep-audit-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
