const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

function validateVoiceInput(payload = {}) {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const speed = Number(payload.speed ?? 1);
  const engine = payload.engine ?? "kokoro";
  const voice = payload.voice ?? (engine === "melo" ? "ZH" : "zf_001");
  if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new Error("请输入要朗读的文字");
  if (Array.from(text).length > 3000) throw new Error("每次最多 3000 字，请分段生成");
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error("语速应在 0.5–2.0 之间");
  if (!["kokoro", "melo"].includes(engine)) throw new Error("请选择有效的语音模型");
  if (typeof voice !== "string" || !(engine === "melo" ? voice === "ZH" : /^(?:z[fm]_\d{3}|af_maple|af_sol|bf_vale)$/.test(voice))) throw new Error("请选择有效的音色");
  return { text, speed, engine, voice };
}

function createVoiceService({ rootDir, workerPath, report = () => {}, blocker = () => "", prepare = async () => {}, settled = () => {} }) {
  let active = null;
  const outputDir = () => path.join(rootDir(), "output", "tts");
  function managedPath(candidate) {
    const target = path.resolve(String(candidate || ""));
    if (path.dirname(target).toLowerCase() !== path.resolve(outputDir()).toLowerCase() || path.extname(target).toLowerCase() !== ".wav") return null;
    try { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) return null; } catch (_) {}
    return target;
  }
  function state(engine = "kokoro") {
    const root = rootDir();
    const modelDir = path.join(root, "models", "tts", "Kokoro-82M-v1.1-zh");
    const meloDir = path.join(root, "models", "tts", "MeloTTS-Chinese");
    let voices = [];
    try { voices = fs.readdirSync(path.join(modelDir, "voices")).filter(name => /^(?:z[fm]_\d{3}|af_maple|af_sol|bf_vale)\.pt$/.test(name)).sort().map(name => {
      const id = name.slice(0, -3);
      return { id, label: `${id.startsWith("zf") ? "中文女声" : id.startsWith("zm") ? "中文男声" : "英文女声"} · ${id}` };
    }); } catch (_) {}
    const common = [path.join(root, "voice", "python", "python.exe"), workerPath];
    const kokoroRequired = [...common, path.join(root, "voice", "python", "Lib", "site-packages", "kokoro", "__init__.py"),
      path.join(root, "voice", "python", "Lib", "site-packages", "misaki", "zh.py"),
      path.join(root, "voice", "python", "Lib", "site-packages", "en_core_web_sm", "__init__.py"),
      path.join(modelDir, "kokoro-v1_1-zh.pth"), path.join(modelDir, "config.json"), path.join(modelDir, "voices", "zf_001.pt")];
    const meloRequired = [...common,
      path.join(root, "voice", "MeloTTS", "melo", "api.py"),
      path.join(meloDir, "checkpoint.pth"), path.join(meloDir, "config.json"),
      path.join(meloDir, "bert", "bert-base-multilingual-uncased", "model.safetensors")];
    const engines = [
      { id: "kokoro", label: "Kokoro-82M-v1.1-zh", sampleRate: 24000, ready: kokoroRequired.every(file => fs.existsSync(file)), voices },
      { id: "melo", label: "MeloTTS 中文", sampleRate: 44100, ready: meloRequired.every(file => fs.existsSync(file)), voices: [{ id: "ZH", label: "默认中文音色" }] },
    ];
    const current = engines.find(item => item.id === engine) || engines[0];
    const required = engine === "melo" ? meloRequired : kokoroRequired;
    const missing = required.filter(file => !fs.existsSync(file));
    return { ready: !missing.length, busy: Boolean(active), model: current.label, engines, sampleRate: current.sampleRate,
      ...(missing.length ? { error: "本地语音组件不完整，请检查 voice 和 models/tts 目录", missing } : {}) };
  }
  function list() {
    if (!fs.existsSync(outputDir())) return [];
    return fs.readdirSync(outputDir()).filter(name => name.endsWith(".wav") && !name.endsWith(".partial.wav")).flatMap(name => {
      const file = managedPath(path.join(outputDir(), name));
      if (!file) return [];
      try {
        const stat = fs.statSync(file);
        let metadata = {};
        try { metadata = JSON.parse(fs.readFileSync(`${file}.json`, "utf8")); } catch (_) {}
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {};
        return [{ text: String(metadata.text || ""), speed: Number(metadata.speed || 1), engine: String(metadata.engine || "melo"), voice: String(metadata.voice || "ZH"),
          duration: Number(metadata.duration || 0), sampleRate: Number(metadata.sampleRate || 44100),
          elapsed: Number(metadata.elapsed || 0), device: String(metadata.device || ""),
          createdAt: Number(metadata.createdAt || stat.mtimeMs), name, path: file,
          url: `${pathToFileURL(file).href}?v=${stat.mtimeMs}`, size: stat.size }];
      } catch (_) { return []; }
    }).sort((a, b) => b.createdAt-a.createdAt).slice(0, 100);
  }
  async function generate(payload) {
    const input = validateVoiceInput(payload);
    if (active) throw new Error("已有语音正在生成，请稍候或停止当前任务");
    const blocked = blocker();
    if (blocked) throw new Error(blocked);
    const health = state(input.engine);
    if (!health.ready) throw new Error(health.error);
    if (!health.engines.find(item => item.id === input.engine)?.voices.some(item => item.id === input.voice)) throw new Error("所选音色文件不存在");
    const id = crypto.randomUUID();
    const filename = `${input.engine === "kokoro" ? "Kokoro" : "MeloTTS"}-${new Date().toISOString().replace(/[:.]/g, "-")}-${id.slice(0,8)}.wav`;
    fs.mkdirSync(outputDir(), { recursive: true });
    const logPath = path.join(rootDir(), "logs", "voice.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = fs.openSync(logPath, "a");
    const job = { id, child: null, canceled: false, filename };
    active = job;
    report({ busy: true, stage: "loading", message: "正在加载本地语音模型…" });
    let timer;
    try {
      await prepare();
      if (job.canceled) throw new Error("语音生成已停止");
      const result = await new Promise((resolve, reject) => {
        const child = spawn(path.join(rootDir(), "voice", "python", "python.exe"), ["-u", workerPath, "--root", rootDir()], {
          cwd: rootDir(), windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", PYTHONNOUSERSITE: "1" },
          stdio: ["pipe", "pipe", log],
        });
        job.child = child;
        let buffer = "", answer = null, failure = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline+1);
            try {
              const message = JSON.parse(line);
              if (message.type === "result") answer = message;
              else if (message.type === "error") failure = message.message;
              else if (message.type === "progress") report({ ...message, busy: true });
            } catch (_) { fs.writeSync(log, `${line}\n`); }
          }
        });
        child.on("error", reject);
        child.stdin.on("error", () => {});
        child.once("close", code => {
          if (job.canceled) reject(new Error("语音生成已停止"));
          else if (job.timedOut) reject(new Error("语音生成超时，请分段重试"));
          else if (code !== 0 || !answer) reject(new Error(failure || "语音生成失败，请查看 logs/voice.log"));
          else resolve(answer);
        });
        child.stdin.end(`${JSON.stringify({ ...input, filename })}\n`, "utf8");
        timer = setTimeout(() => { job.timedOut = true; child.kill(); }, 15 * 60 * 1000);
      });
      const file = managedPath(result.filePath);
      if (!file || path.basename(file) !== filename || !fs.existsSync(file)) throw new Error("生成结果文件不存在");
      const metadata = { ...input, duration: result.duration, elapsed: result.elapsed, sampleRate: result.sampleRate,
        device: result.device, createdAt: Date.now() };
      const sidecar = `${file}.json`;
      fs.writeFileSync(`${sidecar}.tmp`, JSON.stringify(metadata, null, 2), "utf8");
      fs.renameSync(`${sidecar}.tmp`, sidecar);
      return { ok: true, item: list().find(item => item.path === file) };
    } finally {
      clearTimeout(timer);
      const partial = path.join(outputDir(), filename.replace(/\.wav$/, ".partial.wav"));
      try { fs.unlinkSync(partial); } catch (_) {}
      try { fs.closeSync(log); } catch (_) {}
      if (active === job) active = null;
      report({ busy: false, stage: "idle", message: "" });
      settled();
    }
  }
  function cancel() {
    if (!active) return { ok: false, error: "没有正在生成的语音" };
    active.canceled = true;
    active.child?.kill();
    return { ok: true };
  }
  function remove(candidate) {
    const file = managedPath(candidate);
    if (!file || !fs.existsSync(file)) throw new Error("音频不存在");
    fs.unlinkSync(file);
    for (const extension of [".json", ".json.tmp"]) {
      try { fs.unlinkSync(`${file}${extension}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return { ok: true };
  }
  function clear() {
    if (active) throw new Error("请先完成或停止语音生成，再清空记录");
    if (!fs.existsSync(outputDir())) return { ok: true, deleted: 0 };
    let deleted = 0;
    const failed = [];
    // Enumerate the whole output folder; the UI only displays the latest 100.
    const names = fs.readdirSync(outputDir()).sort((a, b) => Number(b.endsWith(".wav")) - Number(a.endsWith(".wav")));
    for (const name of names) {
      if (!/\.wav(?:\.json(?:\.tmp)?)?$/.test(name) || name.includes(".partial.wav")) continue;
      const target = path.join(outputDir(), name);
      if (!name.endsWith(".wav") && fs.existsSync(target.replace(/\.json(?:\.tmp)?$/, ""))) continue;
      try {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        fs.unlinkSync(target);
        if (name.endsWith(".wav")) deleted++;
      } catch (error) { if (error.code !== "ENOENT") failed.push(name); }
    }
    return { ok: !failed.length, deleted, failed, ...(failed.length ? { error: `已删除 ${deleted} 段语音，${failed.length} 个文件未能删除，请关闭占用程序后重试。` } : {}) };
  }
  return { get busy() { return Boolean(active); }, state, list, generate, cancel, remove, clear, managedPath, dispose: cancel };
}

module.exports = { createVoiceService, validateVoiceInput };
