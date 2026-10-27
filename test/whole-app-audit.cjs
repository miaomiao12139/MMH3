const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createPreferenceStore } = require('../src/preferences.cjs');
const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const section = (start, end) => main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start)));

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-whole-audit-'));
  try {
    const ratioAssignment = section('  const aspectRatio = ({', '  Object.values(graph).forEach');
    for (const [short, full] of Object.entries({ '1:1': '1:1 (Square)', '16:9': '16:9 (Widescreen)', '9:16': '9:16 (Portrait Widescreen)' })) {
      for (const input of [short, full]) {
        const context = { settings: { aspectRatio: input } };
        vm.runInNewContext(ratioAssignment + '\nthis.result = aspectRatio;', context);
        assert.equal(context.result, full);
      }
    }
    console.log('PASS short and full aspect ratios map to valid backend options');
    let failWrite = false;
    const store = createPreferenceStore(() => root, (file, text) => {
      if (failWrite) throw Error('disk full');
      fs.writeFileSync(file, text);
    });
    store.load(); store.save('minimax-h3-theme', 'dark');
    const preferencesPath = path.join(root, 'user/studio-preferences.json');
    assert.equal(JSON.parse(fs.readFileSync(preferencesPath)).values['minimax-h3-theme'], 'dark');
    failWrite = true;
    assert.throws(() => store.save('minimax-h3-theme', 'light'), /disk full/);
    assert.equal(store.values()['minimax-h3-theme'], 'dark');
    failWrite = false; store.flush();
    assert.equal(JSON.parse(fs.readFileSync(preferencesPath)).values['minimax-h3-theme'], 'dark');
    console.log('PASS settings persist before success and rollback after write failure');

    const output = path.join(root, 'output'); fs.mkdirSync(output);
    for (const name of ['clip.mp4', '..clip.mp4', 'speech.wav', 'image.png']) fs.writeFileSync(path.join(output, name), name);
    fs.mkdirSync(path.join(output, 'folder.mp4'));
    const handlers = new Map(); let metadata = {};
    const context = { fs, path, crypto, process, spawn, rootDir: () => root, win: null, pathToFileURL,
      readStudioHistory: () => structuredClone(metadata), writeStudioHistory: value => { metadata = value; },
      inferWorkflowFromOutput: () => 't2v',
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
    };
    vm.createContext(context);
    vm.runInContext(section('function listVideoFiles(', 'function readStudioHistory('), context);
    const valid = file => context.outputFilePath(path.join(output, file));
    assert.equal(valid('speech.wav'), null); assert.equal(valid('image.png'), null);
    assert.equal(valid('folder.mp4'), null); assert.equal(valid('missing.mp4'), null);
    assert.equal(valid('..clip.mp4'), path.join(output, '..clip.mp4'));
    assert.equal(context.outputFilePath(path.join(output, 'image.png'), false), path.join(output, 'image.png'));
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.mp4'), 'keep');
    fs.symlinkSync(outside, path.join(output, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(valid(path.join('external', 'keep.mp4')), null);
    assert.equal(context.listVideoFiles().some(item => item.path.includes('external')), false);
    console.log('PASS video actions reject audio, images, directories and outside junctions; image reveal remains available');

    vm.runInContext(section('ipcMain.handle("clear-videos"', 'ipcMain.handle("open-video"'), context);
    const clear = handlers.get('clear-videos');
    assert.equal((await clear({ integration: true }, '', 'record')).ok, false);
    assert.ok(fs.existsSync(path.join(output, 'clip.mp4')));
    assert.equal((await clear({ integration: true }, '', 'records')).ok, true);
    assert.equal(context.listVideoFiles().length, 0);
    assert.ok(fs.existsSync(path.join(output, 'clip.mp4')));
    assert.equal((await clear({ integration: true }, '', 'delete')).count, 2);
    assert.ok(fs.existsSync(path.join(output, 'speech.wav')));
    assert.ok(fs.existsSync(path.join(outside, 'keep.mp4')));
    console.log('PASS invalid clear modes cannot delete; records remain hidden after refresh; later delete includes hidden videos');

    if (process.platform === 'win32') {
      const zip = path.join(root, '导出.zip');
      const image = path.join(output, 'image.png');
      context.cutoutService = { get: () => ({ path: image }) };
      context.dialog.showSaveDialog = async () => ({ filePath: zip });
      // Reproduce launch from a PowerShell 7 environment with an unusable module path.
      context.spawn = (command, args, options) => spawn(command, args, { ...options, env: { ...process.env, PSModulePath: 'C:\\nonexistent-modules' } });
      vm.runInContext(section('ipcMain.handle("export-cutout-batch"', 'ipcMain.handle("clear-cutouts"'), context);
      const exportZip = handlers.get('export-cutout-batch');
      assert.equal((await exportZip(null, ['one'])).ok, true);
      const original = fs.readFileSync(zip);
      assert.equal(original.subarray(0, 2).toString(), 'PK');
      context.cutoutService.get = () => ({ path: path.join(output, 'folder.mp4') });
      // A locked/missing source after selection must not replace a previous export.
      context.spawn = (command, args, options) => spawn(command, ['-NoProfile', '-Command', 'exit 1'], options);
      assert.equal((await exportZip(null, ['bad'])).ok, false);
      assert.deepEqual(fs.readFileSync(zip), original);
      console.log('PASS ZIP export works with inherited invalid module path; failed export preserves existing archive');
    }
  } finally {
    // Remove only this test's resolved temporary fixture, including the junction itself.
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
