const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const WebSocket = require("ws");
const { cancelPrompt, describeEngineError } = require("./runtime.cjs");

function validateCutoutGraph(graph) {
  const nodes = Object.values(graph || {});
  const input = Object.entries(graph || {}).find(([, node]) => node.class_type === "LoadImage");
  const remover = Object.entries(graph || {}).find(([, node]) => node.class_type === "InspyrenetRembg");
  const output = nodes.find((node) => node.class_type === "SaveImage");
  if (nodes.length !== 3 || !input || !remover || !output) return "抠图工作流需要 LoadImage、InspyrenetRembg 和 SaveImage";
  if (String(remover[1].inputs?.image?.[0]) !== input[0] || remover[1].inputs.image[1] !== 0 || String(output.inputs?.images?.[0]) !== remover[0] || output.inputs.images[1] !== 0) return "抠图工作流连接不正确";
  return "";
}

function createCutoutService({ rootDir, requestJson, reportProgress, atomicWriteText, getPort }) {
  const outputDir = () => path.join(rootDir(), "output", "ai-cutout");
  const assetDir = () => path.join(rootDir(), "user", "cutout-assets");
  const historyPath = () => path.join(rootDir(), "user", "studio-cutouts.json");
  const readHistory = () => {
    try {
      const entries = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
      const ids = new Set();
      if (!Array.isArray(entries) || entries.some(entry => {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || typeof entry.filename !== "string" || !entry.filename || (entry.sourceName !== undefined && typeof entry.sourceName !== "string")) return true;
        ids.add(entry.id);
        return false;
      })) throw new Error("文件结构无效");
      return entries;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error(`读取抠图历史失败：${error.message}。原文件已保留，请检查 user/studio-cutouts.json`);
    }
  };
  const writeHistory = (entries) => {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    atomicWriteText(historyPath(), JSON.stringify(entries, null, 2));
  };
  const safeFile = (directory, filename) => {
    const normalized = String(filename || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
    const file = path.resolve(directory, normalized);
    const base = path.resolve(directory);
    const relativeToBase = path.relative(base, file);
    if (!relativeToBase || relativeToBase.startsWith("..") || path.isAbsolute(relativeToBase)) return null;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? file : null;
  };
  const publicEntry = (entry) => {
    const file = safeFile(outputDir(), entry.filename);
    const source = safeFile(assetDir(), entry.sourceName);
    return { ...entry, path: file || "", url: file ? pathToFileURL(file).href : "", missingOutput: !file, sourcePath: source || "", sourceUrl: source ? pathToFileURL(source).href : "", size: file ? fs.statSync(file).size : 0 };
  };
  const list = () => readHistory().map(publicEntry).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  const get = (id) => {
    const entry = readHistory().find((item) => item.id === id);
    const result = entry && publicEntry(entry);
    if (!result || result.missingOutput) throw new Error("抠图结果不存在，可能已被移动或删除");
    return result;
  };
  const forget = (id) => writeHistory(readHistory().filter((item) => item.id !== id));
  const removeEntries = (selected = null) => {
    const entries = readHistory();
    const retained = [];
    const failures = [];
    let removed = 0, files = 0;
    for (const entry of entries) {
      if (selected && !selected.has(entry.id)) { retained.push(entry); continue; }
      const output = safeFile(outputDir(), entry.filename);
      const source = safeFile(assetDir(), entry.sourceName);
      let failed = false;
      for (const file of [output, source]) {
        if (!file) continue;
        try { fs.unlinkSync(file); files += 1; }
        catch (error) {
          if (error.code === "ENOENT") continue;
          failed = true;
          failures.push(`${entry.originalName || entry.filename}：${error.message}`);
          break;
        }
      }
      if (failed) retained.push(entry);
      else removed += 1;
    }
    if (removed) {
      try { writeHistory(retained); }
      catch (error) { return { ok: false, entries: 0, files, failed: entries.length - retained.length + failures.length, changed: files > 0, error: `已删除 ${files} 个文件，但抠图历史保存失败：${error.message}。原记录已保留，可重试清理` }; }
    }
    return { ok: failures.length === 0, entries: removed, files, failed: failures.length, changed: removed > 0 || files > 0,
      ...(failures.length ? { error: `已清理 ${removed} 条抠图记录，${failures.length} 条未完成：${failures.slice(0, 3).join("；")}` } : {}) };
  };
  const clear = () => removeEntries();
  const remove = (id) => {
    if (!readHistory().some(entry => entry.id === id)) throw new Error("找不到抠图记录");
    return removeEntries(new Set([id]));
  };
  const safeStem = (value, fallback = "cutout") => String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 120) || fallback;
  const convertToWebp = (source, target) => new Promise((resolve, reject) => {
    const python = path.join(rootDir(), "python", "python.exe");
    if (!fs.existsSync(python)) return reject(new Error("找不到 Python，无法导出 WebP；请改用 PNG"));
    const script = "from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.save(sys.argv[2], 'WEBP', quality=95, method=6)";
    const child = spawn(python, ["-c", script, source, target], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 && fs.existsSync(target) ? resolve() : reject(new Error(stderr.trim() || "WebP 转换失败")));
  });
  const finalizeOutput = async (sourceFile, source, job, id) => {
    const options = job.cutoutOptions || {};
    const format = String(options.format || "png").toLowerCase() === "webp" ? "webp" : "png";
    const preserveName = options.preserveName !== false;
    const prefix = safeStem(options.filenamePrefix || "", "");
    const originalStem = safeStem(path.parse(source).name, "image");
    const baseName = `${prefix}${preserveName ? originalStem : "cutout"}`;
    const folder = options.batchFolder ? safeStem(options.batchName || `batch-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`, "batch") : "";
    const targetDir = folder ? path.join(outputDir(), folder) : outputDir();
    fs.mkdirSync(targetDir, { recursive: true });
    const extension = `.${format}`;
    let filename = `${baseName}${extension}`;
    let target = path.join(targetDir, filename);
    if (fs.existsSync(target)) {
      const suffix = String(id).slice(0, 8);
      filename = `${baseName}-${suffix}${extension}`;
      target = path.join(targetDir, filename);
    }
    if (format === "webp") await convertToWebp(sourceFile, target);
    else fs.copyFileSync(sourceFile, target);
    if (path.resolve(sourceFile) !== path.resolve(target)) {
      try { fs.unlinkSync(sourceFile); } catch (_) {}
    }
    return { target, filename: path.relative(outputDir(), target).replace(/\\/g, "/"), format };
  };
  const check = async () => {
    try {
      const info = await requestJson("GET", "/object_info/InspyrenetRembg");
      if (!info.InspyrenetRembg) return { ok: false, error: "抠图节点未加载，请安装 ComfyUI-Inspyrenet-Rembg 后重启软件" };
      return { ok: true };
    } catch (error) { return { ok: false, error: `抠图引擎未就绪：${error.message}` }; }
  };
  const run = async (job, task) => {
    readHistory();
    const available = await check();
    if (!available.ok) throw new Error(available.error);
    const graph = structuredClone(job.workflowGraph);
    const invalid = validateCutoutGraph(graph);
    if (invalid) throw new Error(invalid);
    const source = job.media?.[0];
    if (!source || !/\.(png|jpe?g|webp|avif)$/i.test(source) || !fs.existsSync(source)) throw new Error("找不到待抠图图片，请重新添加");
    const id = crypto.randomUUID();
    const inputName = `cutout_${id}${path.extname(source).toLowerCase()}`;
    const inputPath = path.join(rootDir(), "input", inputName);
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.mkdirSync(outputDir(), { recursive: true });
    fs.mkdirSync(assetDir(), { recursive: true });
    const saveId = Object.keys(graph).find((key) => graph[key].class_type === "SaveImage");
    Object.values(graph).forEach((node) => {
      if (node.class_type === "LoadImage") node.inputs.image = inputName;
      if (node.class_type === "SaveImage") node.inputs.filename_prefix = `ai-cutout/${id}`;
    });
    const emit = (label, value, nodeId = "", extra = {}) => reportProgress(job.id, { label, value, max: 100, node: label, nodeId, indeterminate: value < 100, ...extra });
    let socket;
    let promptId;
    let historyComplete = false;
    let executionError = "";
    let lastEvent = 0;
    const buffered = [];
    const onMessage = (message) => {
      const data = message.data || {};
      if (data.prompt_id !== promptId) return;
      lastEvent = Date.now();
      if (message.type === "execution_error") executionError = String(data.exception_message || "抠图节点执行失败");
      if (message.type === "execution_interrupted") executionError = "抠图任务已被引擎中断";
      if (message.type === "executing" && data.node) {
        const kind = graph[String(data.node)]?.class_type;
        const label = kind === "InspyrenetRembg" ? "正在识别主体并去除背景" : kind === "SaveImage" ? "正在保存透明 PNG" : "正在读取原图";
        emit(label, kind === "SaveImage" ? 90 : 10, String(data.node));
      }
    };
    try {
      fs.copyFileSync(source, inputPath);
      emit("正在准备图片", 0);
      socket = new WebSocket(`ws://127.0.0.1:${getPort()}/ws?clientId=cutout-${id}`);
      task.ws = socket;
      socket.on("error", () => {});
      socket.on("message", (raw, binary) => {
        if (binary) return;
        try { const event = JSON.parse(raw.toString()); if (promptId) onMessage(event); else if (buffered.length < 100) buffered.push(event); } catch (_) {}
      });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        socket.once("open", () => { clearTimeout(timer); resolve(); });
        socket.once("error", () => { clearTimeout(timer); resolve(); });
      });
      if (task.canceled) throw new Error("任务已取消");
      const submitted = await requestJson("POST", "/prompt", { prompt: graph, client_id: `cutout-${id}` });
      if (submitted.error || !submitted.prompt_id) throw new Error(describeEngineError(submitted, "抠图工作流提交失败：引擎未返回任务编号"));
      promptId = submitted.prompt_id;
      task.promptId = promptId;
      if (task.canceled) throw new Error("任务已取消");
      emit("等待本地引擎处理", 0);
      buffered.forEach(onMessage);
      const deadline = Date.now() + 20 * 60 * 1000;
      while (Date.now() < deadline) {
        if (task.canceled) throw new Error("任务已取消");
        const history = await requestJson("GET", `/history/${encodeURIComponent(promptId)}`);
        const record = history[promptId];
        if (record) {
          historyComplete = true;
          if (task.canceled) throw new Error("任务已取消");
          if (["error", "execution_error"].includes(record.status?.status_str)) throw new Error(describeEngineError(record, executionError || "抠图失败，请查看引擎日志"));
          const saved = record.outputs?.[saveId]?.images?.find((item) => item.type === "output" && item.filename?.startsWith(id) && item.filename.endsWith(".png") && item.subfolder?.replace(/\\/g, "/") === "ai-cutout");
          const rawFile = saved && safeFile(outputDir(), saved.filename);
          if (!rawFile) throw new Error("抠图任务未返回有效的透明 PNG");
          const finalized = await finalizeOutput(rawFile, source, job, id);
          const file = safeFile(outputDir(), finalized.filename);
          if (!file) throw new Error("抠图输出文件无效");
          const sourceName = `${id}${path.extname(source).toLowerCase()}`;
          fs.copyFileSync(source, path.join(assetDir(), sourceName));
          const entry = {
            id,
            jobId: job.id,
            batchId: job.batchId || "",
            batchIndex: Number(job.batchIndex) || 0,
            batchTotal: Number(job.batchTotal) || 0,
            filename: finalized.filename,
            outputFormat: finalized.format,
            sourceName,
            originalName: job.inputName || path.basename(source),
            createdAt: Date.now(),
          };
          writeHistory([entry, ...readHistory()]);
          emit("抠图完成", 100, "", { indeterminate: false });
          return { outputPath: file, outputPaths: [file] };
        }
        if (executionError) throw new Error(executionError);
        if (Date.now() - lastEvent > 5000) {
          const queue = await requestJson("GET", "/queue");
          const pending = queue.queue_pending?.some((item) => item[1] === promptId);
          const running = queue.queue_running?.some((item) => item[1] === promptId);
          if (pending) emit("等待前面的任务完成", 0);
          else if (running && !lastEvent) emit("正在去除背景，等待节点反馈", 10);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("抠图等待超时，请检查本地引擎");
    } finally {
      if (promptId && !historyComplete) {
        try { await cancelPrompt(requestJson, promptId); }
        catch (error) { console.error("撤销抠图引擎任务失败", error); }
      }
      if (socket) socket.terminate();
      try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); }
      catch (error) { console.error("清理抠图临时输入失败", error); }
    }
  };
  return { check, run, list, get, forget, clear, remove };
}

module.exports = { createCutoutService, validateCutoutGraph };
