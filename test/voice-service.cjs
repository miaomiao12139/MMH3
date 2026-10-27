const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVoiceService, validateVoiceInput } = require('../src/voice.cjs');

async function main() {
  for (const payload of [{}, { text: '   ' }, { text: '。！？' }, { text: '字'.repeat(3001) }, { text: '你好', speed: 0 }, { text: '你好', speed: Infinity }]) assert.throws(() => validateVoiceInput(payload));
  assert.deepEqual(validateVoiceInput({ text: '  中文和 English  ', speed: '1.25' }), { text: '中文和 English', speed: 1.25, engine: 'kokoro', voice: 'zf_001' });
  assert.deepEqual(validateVoiceInput({ text: '你好', engine: 'melo' }), { text: '你好', speed: 1, engine: 'melo', voice: 'ZH' });
  for (const payload of [{engine:'other'}, {voice:'../../outside'}, {voice:14}, {engine:'melo', voice:'zf_001'}]) assert.throws(() => validateVoiceInput({text:'你好', ...payload}));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-voice-test-'));
  try {
    const output = path.join(root, 'output', 'tts');
    fs.mkdirSync(output, { recursive: true });
    const file = path.join(output, 'example.wav');
    const external = path.join(root, 'external.wav');
    fs.writeFileSync(file, 'wav'); fs.writeFileSync(external, 'keep');
    fs.writeFileSync(`${file}.json`, JSON.stringify({ text: '保存的中文', duration: 2, speed: 1.2, createdAt: 100 }));
    fs.writeFileSync(path.join(output, 'unfinished.partial.wav'), 'partial');
    const service = createVoiceService({ rootDir: () => root, workerPath: __filename, blocker: () => '视频正在生成' });
    const entries = service.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, '保存的中文');
    assert.equal(entries[0].duration, 2);
    assert.equal(entries[0].engine, 'melo');
    assert.equal(entries[0].voice, 'ZH');
    assert.equal(service.managedPath(external), null);
    assert.equal(service.managedPath(path.join(output, '..', 'external.wav')), null);
    assert.throws(() => service.remove(external));
    await assert.rejects(service.generate({ text: '你好' }), /视频正在生成/);
    assert.equal(service.busy, false);
    assert.equal(service.state().ready, false);
    assert.equal(service.cancel().ok, false);
    const moved = path.join(root, 'moved-app');
    fs.mkdirSync(path.join(moved, 'output', 'tts'), { recursive: true });
    fs.copyFileSync(file, path.join(moved, 'output', 'tts', 'example.wav'));
    fs.copyFileSync(`${file}.json`, path.join(moved, 'output', 'tts', 'example.wav.json'));
    const relocated = createVoiceService({ rootDir: () => moved, workerPath: __filename });
    assert.equal(relocated.list()[0].text, '保存的中文');
    assert.equal(relocated.list()[0].path, path.join(moved, 'output', 'tts', 'example.wav'));
    fs.writeFileSync(`${file}.json`, 'null');
    assert.equal(service.list().length, 1, 'Null metadata must not hide an existing WAV');
    service.remove(file);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(`${file}.json`), false);
    assert.equal(fs.readFileSync(external, 'utf8'), 'keep');
    for (let index = 0; index < 151; index++) {
      const sample = path.join(output, `batch-${index}.wav`);
      fs.writeFileSync(sample, 'wav');
      fs.writeFileSync(`${sample}.json`, '{}');
    }
    fs.writeFileSync(path.join(output, 'orphan.wav.json'), '{}');
    fs.writeFileSync(path.join(output, 'notes.txt'), 'keep');
    assert.equal(service.list().length, 100);
    const locked = path.join(output, 'batch-0.wav');
    const unlink = fs.unlinkSync;
    let cleared;
    try {
      fs.unlinkSync = target => { if (target === locked) throw Object.assign(new Error('locked'), {code:'EBUSY'}); return unlink(target); };
      cleared = service.clear();
    } finally { fs.unlinkSync = unlink; }
    assert.equal(cleared.ok, false);
    assert.equal(cleared.deleted, 150);
    assert.ok(fs.existsSync(`${locked}.json`), 'Failed WAV deletion must preserve its metadata');
    assert.equal(service.list().length, 1);
    assert.equal(service.clear().deleted, 1);
    assert.equal(service.list().length, 0);
    assert.ok(fs.existsSync(path.join(output, 'notes.txt')));
    assert.ok(fs.existsSync(path.join(output, 'unfinished.partial.wav')));
    assert.equal(fs.readFileSync(external, 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(output, 'orphan.wav.json')), false);
    const required = ['voice/python/python.exe', 'voice/python/Lib/site-packages/kokoro/__init__.py', 'voice/python/Lib/site-packages/misaki/zh.py', 'voice/python/Lib/site-packages/en_core_web_sm/__init__.py', 'models/tts/Kokoro-82M-v1.1-zh/kokoro-v1_1-zh.pth', 'models/tts/Kokoro-82M-v1.1-zh/config.json', 'models/tts/Kokoro-82M-v1.1-zh/voices/zf_001.pt'];
    for (const rel of required) { const target = path.join(root, rel); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, 'fixture'); }
    let release;
    const deferred = new Promise(resolve => { release = resolve; });
    const generating = createVoiceService({rootDir:()=>root, workerPath:__filename, prepare:()=>deferred});
    const pending = generating.generate({text:'测试'});
    assert.throws(() => generating.clear(), /停止语音生成/);
    generating.cancel(); release();
    await assert.rejects(pending, /已停止/);
    console.log('Voice service: invalid inputs, GPU exclusion, output path boundaries, history relocation and deletion passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
