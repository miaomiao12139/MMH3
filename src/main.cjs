const { app, BrowserWindow, dialog, ipcMain, shell, Menu, screen, clipboard, Notification } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const https = require("https");
const WebSocket = require("ws");
const { pathToFileURL, fileURLToPath } = require("url");
const { createCutoutService, validateCutoutGraph } = require("./cutout.cjs");
const { createVoiceService } = require("./voice.cjs");
const { createIntegrationJobs } = require("./integration-jobs.cjs");
const { resolveRuntimeRoot, relocatePath, relocateStoredPaths, cancelPrompt, describeEngineError } = require("./runtime.cjs");
const { createPreferenceStore } = require("./preferences.cjs");
const { styles: generationStyles, applyGenerationSettings, styledPrompt, bindGenerationInputs, validateGenerationInputs, outputSize, resolveGenerationSettings } = require("./generation.cjs");

const { savedVideoPaths } = require("./outputs.cjs");
const { validateSegmentPrompts } = require("./segmentation.cjs");

let win;
let backend;
let port;
let backendReady = false;
let clientId = crypto.randomUUID();
let activeTask = { promptId: null, ws: null };
let activeQueueJobId = "";
let queueJobs = null;
let queueLoadError = "";
let queueWorkerPromise = null;
let queuePaused = false;
let activeCutoutBatch = null;
let backendLogFd = null;
let backendDbPath = "";
// Keep the same implementations for desktop IPC and the explicit HTTP action allowlist.
const studioHandlers = new Map();
const registerStudioIpc = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => { studioHandlers.set(channel, handler); return registerStudioIpc(channel, handler); };
let integrationJobs;
let studioApiServer = null;
let studioApiPort = 0;
let studioApiToken = "";
let objectInfoCache = { at: 0, data: null };
let cutoutService;
let voiceService;
let activeAiTool = null;
let runtimeRootCache = "";
let updateInProgress = false;
const queueProgressPersistAt = new Map();
const DEFAULT_QUEUE_RETENTION_DAYS = 30;
const UPDATE_REPO = "miaomiao12139/MMH3";
const imageAssetPattern = /\.(png|jpe?g|webp|avif)$/i;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const preferences = createPreferenceStore(rootDir, atomicWriteText);
const stagedAssetTimes = new Map();

function rotateLog(filePath, maxBytes = 10 * 1024 * 1024) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > maxBytes) {
      const archive = `${filePath}.1`;
      if (fs.existsSync(archive)) fs.unlinkSync(archive);
      fs.renameSync(filePath, archive);
    }
  } catch (_) {}
}

function openLog(filePath) {
  rotateLog(filePath);
  return fs.openSync(filePath, "a");
}

function hasRuntimeLayout(directory) {
  if (!directory) return false;
  try {
    return fs.existsSync(path.join(directory, "python", "python.exe"))
      && fs.existsSync(path.join(directory, "ComfyUI", "main.py"));
  } catch (_) { return false; }
}

function rootDir() {
  if (runtimeRootCache) return runtimeRootCache;
  runtimeRootCache = resolveRuntimeRoot({
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    executableDir: path.dirname(process.execPath),
    resourcesDir: process.resourcesPath && path.dirname(process.resourcesPath),
    developmentDir: !app.isPackaged ? path.resolve(__dirname, "..", "..", "..", "App") : "",
  });
  return runtimeRootCache;
}

function getVoiceService() {
  if (!voiceService) voiceService = createVoiceService({
    rootDir,
    workerPath: app.isPackaged ? path.join(process.resourcesPath, "runtime", "voice-worker.py") : path.join(__dirname, "voice-worker.py"),
    report: progress => emit("voice-progress", progress),
    blocker: () => updateInProgress ? "正在更新软件，请稍候" : (activeQueueJobId || activeCutoutBatch || activeAiTool || activeTask.promptId) ? "本地引擎正在执行任务，请完成或停止后再生成语音" : "",
    prepare: async () => {
      if (backendReady && port) {
        const queue = await requestJson("GET", "/queue");
        if (queue.queue_running?.length) throw new Error("本地引擎有任务正在执行，请完成后再生成语音");
        await requestJson("POST", "/free", { unload_models: true, free_memory: true });
      }
    },
    settled: () => { processQueue().catch(error => emit("status", error.message)); },
  });
  return voiceService;
}

function queueStatePath() {
  return path.join(rootDir(), "user", "studio-queue.json");
}

function queueControlPath() {
  return path.join(rootDir(), "user", "studio-queue-settings.json");
}

function readQueueRetentionDays() {
  try {
    const state = JSON.parse(fs.readFileSync(queueControlPath(), "utf8"));
    const value = Number(state?.retentionDays);
    if (value === 0 || [7, 30, 90].includes(value)) return value;
  } catch (_) {}
  return DEFAULT_QUEUE_RETENTION_DAYS;
}

function writeQueueRetentionDays(value) {
  const retentionDays = Number(value) === 0 ? 0 : ([7, 30, 90].includes(Number(value)) ? Number(value) : DEFAULT_QUEUE_RETENTION_DAYS);
  try {
    fs.mkdirSync(path.dirname(queueControlPath()), { recursive: true });
    atomicWriteText(queueControlPath(), JSON.stringify({ paused: Boolean(queuePaused), retentionDays }, null, 2));
    return { ok: true, retentionDays };
  } catch (error) {
    return { ok: false, retentionDays, error: error.message };
  }
}

function readQueuePaused() {
  try {
    const state = JSON.parse(fs.readFileSync(queueControlPath(), "utf8"));
    return Boolean(state && state.paused);
  } catch (_) {
    return false;
  }
}

function writeQueuePaused(value) {
  try {
    fs.mkdirSync(path.dirname(queueControlPath()), { recursive: true });
    atomicWriteText(queueControlPath(), JSON.stringify({ paused: Boolean(value), retentionDays: readQueueRetentionDays() }, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function atomicWriteText(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  try {
    // Windows portable builds can run from mapped, removable, or non-NTFS drives
    // where fsync is unsupported (EPERM). The atomic rename below still protects
    // the JSON from partial writes, so treat the flush as best effort on Windows.
    if (process.platform !== "win32") {
      const descriptor = fs.openSync(temporaryPath, "r");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    if (process.platform === "win32" && fs.existsSync(filePath)) {
      const backupPath = `${filePath}.bak-${process.pid}`;
      try {
        if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
        fs.renameSync(filePath, backupPath);
        try {
          fs.renameSync(temporaryPath, filePath);
          fs.rmSync(backupPath, { force: true });
        } catch (error) {
          try { fs.renameSync(backupPath, filePath); } catch (_) {}
          throw error;
        }
      } catch (error) {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        throw error;
      }
    } else {
      fs.renameSync(temporaryPath, filePath);
    }
  } catch (error) {
    try { if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
    throw error;
  }
}

function queueInputDir(jobId) {
  return path.join(rootDir(), "user", "queue-input", jobId);
}

function queueInputsUsedByDraft(jobId) {
  const directory = queueInputDir(jobId);
  try {
    let raw = preferences.values()["minimax-h3-workflow-drafts-v1"];
    let previousRoot = "";
    if (raw === undefined) {
      const stored = path.join(rootDir(), "user", "studio-preferences.json");
      if (!fs.existsSync(stored)) return false;
      const state = JSON.parse(fs.readFileSync(stored, "utf8"));
      raw = state.values?.["minimax-h3-workflow-drafts-v1"];
      previousRoot = state.runtimeRoot || "";
    }
    if (!raw) return false;
    const drafts = relocateStoredPaths(JSON.parse(raw), rootDir(), previousRoot);
    const contains = value => {
      if (typeof value === "string") {
        const file = value.startsWith("file:") ? fileURLToPath(value) : value;
        return path.isAbsolute(file) && isWithin(directory, file);
      }
      if (Array.isArray(value)) return value.some(contains);
      return value && typeof value === "object" ? Object.values(value).some(contains) : false;
    };
    return contains(drafts);
  } catch (_) { return true; }
}

function pruneQueueInputDirs() {
  const baseDir = path.join(rootDir(), "user", "queue-input");
  if (!fs.existsSync(baseDir) || !fs.existsSync(queueStatePath())) return;
  const jobs = new Map(readQueueJobs().map((job) => [String(job.id || ""), job]));
  if (queueLoadError) return;
  const now = Date.now();
  const retentionDays = readQueueRetentionDays();
  const retentionMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : 0;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const job = jobs.get(entry.name);
    let remove = !job;
    if (job && retentionMs > 0 && ["completed", "failed", "cancelled", "interrupted"].includes(job.state)) {
      try { remove = now - fs.statSync(path.join(baseDir, entry.name)).mtimeMs > retentionMs; } catch (_) {}
    }
    if (remove && !queueInputsUsedByDraft(entry.name)) {
      try { fs.rmSync(path.join(baseDir, entry.name), { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function pruneRuntimeDatabases() {
  const directory = path.join(rootDir(), "user");
  try {
    for (const name of fs.readdirSync(directory)) {
      if (/^comfyui-\d+\.db$/i.test(name)) fs.rmSync(path.join(directory, name), { force: true });
    }
  } catch (_) {}
}

function readQueueJobs() {
  if (queueJobs) return queueJobs;
  try {
    const parsed = JSON.parse(fs.readFileSync(queueStatePath(), "utf8"));
    const states = new Set(["queued", "preparing", "running", "completed", "failed", "cancelled", "interrupted"]);
    const ids = new Set();
    if (!Array.isArray(parsed) || parsed.some(job => {
      if (!job || typeof job !== "object" || Array.isArray(job) || typeof job.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(job.id) || !states.has(job.state) || ids.has(job.id)) return true;
      ids.add(job.id);
      return ["media", "sourceMedia", "referenceAssets", "outputPaths"].some(key => job[key] !== undefined && !Array.isArray(job[key]));
    })) throw new Error("队列文件结构无效");
    queueJobs = parsed;
  } catch (error) {
    queueJobs = [];
    if (error.code !== "ENOENT") queueLoadError = `队列读取失败：${error.message}。原队列文件和输入缓存已保留，请修复 user/studio-queue.json 后重启软件`;
  }
  queueJobs = queueJobs.map((job) => job && typeof job === "object" ? job : null).filter(Boolean).map((job) => {
    job = relocateStoredPaths(job, rootDir(), job.runtimeRoot);
    if (job.state === "running" || job.state === "preparing") return { ...job, state: "interrupted", error: "应用上次未正常结束，请重试" };
    return job;
  });
  return queueJobs;
}

function writeQueueJobs() {
  try {
    readQueueJobs();
    if (queueLoadError) throw new Error(queueLoadError);
    const filePath = queueStatePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteText(filePath, JSON.stringify(readQueueJobs().map((job) => ({ ...job, runtimeRoot: rootDir() })), null, 2));
    return true;
  } catch (error) {
    emit("status", `队列保存失败：${error.message}`);
    return false;
  }
}

function publicQueueJob(job, position = 0) {
  const media = Array.isArray(job.media) ? job.media : [];
  const sourceMedia = Array.isArray(job.sourceMedia) ? job.sourceMedia : [];
  const referenceAssets = Array.isArray(job.referenceAssets) ? job.referenceAssets : [];
  const available = (...candidates) => candidates.find((file) => {
    try { return Boolean(file) && fs.statSync(file).isFile(); } catch (_) { return false; }
  }) || "";
  const referencePreviewPaths = referenceAssets.map((asset) => available(asset?.filePath, asset?.sourcePath));
  const fallbackMediaPaths = Array.from({ length: Math.max(media.length, sourceMedia.length) }, (_, index) => available(media[index], sourceMedia[index]));
  const previewPaths = referenceAssets.length ? referencePreviewPaths : fallbackMediaPaths;
  const outputPaths = Array.isArray(job.outputPaths) ? job.outputPaths : (job.outputPath ? [job.outputPath] : []);
  const availableOutputPaths = outputPaths.filter((file) => {
    try { return Boolean(file) && fs.statSync(file).isFile(); } catch (_) { return false; }
  });
  const outputMissing = job.state === "completed" && (outputPaths.length === 0 || availableOutputPaths.length === 0);
  return {
    id: job.id,
    workflowId: job.workflowId,
    workflowName: job.workflowName,
    prompt: job.prompt || "",
    originalPrompt: job.originalPrompt || job.prompt || "",
    promptParts: Array.isArray(job.promptParts) ? job.promptParts : [],
    references: Array.isArray(job.references) ? job.references : [],
    mediaCount: referenceAssets.length || media.length || sourceMedia.length,
    mediaPreviews: previewPaths.filter(Boolean).map((file) => pathToFileURL(file).href),
    // Keep the staged input paths available to the renderer so a queued task
    // can be reopened and edited without asking the user to select files again.
    mediaPaths: fallbackMediaPaths,
    referenceAssets: referenceAssets.map((asset, index) => ({
      assetId: String(asset?.assetId || asset?.id || `reference-${index + 1}`),
      type: "image",
      index: index + 1,
      modelToken: `<Picture ${index + 1}>`,
      filePath: referencePreviewPaths[index],
      previewUrl: referencePreviewPaths[index] ? pathToFileURL(referencePreviewPaths[index]).href : "",
    })),
    settings: { ...(job.settings || {}), fps: 24 },
    state: job.state,
    progress: job.progress || { value: 0, max: 100, label: "排队中" },
    error: job.error || "",
    outputPath: job.outputPath || "",
    outputPaths,
    outputMissing,
    createdAt: job.createdAt,
    startedAt: job.startedAt || 0,
    completedAt: job.completedAt || 0,
    attempts: job.attempts || 0,
    batchId: job.batchId || "",
    batchIndex: Number(job.batchIndex) || 0,
    batchTotal: Number(job.batchTotal) || 0,
    position,
  };
}

function queueSnapshot() {
  const jobs = readQueueJobs();
  if (queueLoadError) emit("status", queueLoadError);
  return jobs.filter((job) => job.workflowId !== "cutout").map((job, index) => publicQueueJob(job, index + 1));
}

function emitQueue() {
  emit("queue-updated", queueSnapshot());
  emit("queue-control", { paused: queuePaused });
}

function setJobProgress(job, progress) {
  const nodeStep = Number(progress.nodeStep);
  const nodeTotal = Number(progress.nodeTotal);
  const detailStep = Number(progress.detailStep);
  const detailStepMax = Number(progress.detailStepMax);
  const nodeId = progress.nodeId === undefined || progress.nodeId === null ? "" : String(progress.nodeId);
  job.progress = {
    attempt: job.attempts || 0,
    value: Number(progress.value) || 0,
    max: Number(progress.max) || 100,
    label: progress.label || "生成中",
    node: progress.node || "",
    nodeId,
    indeterminate: Boolean(progress.indeterminate),
    ...(Number.isFinite(nodeStep) ? { nodeStep } : {}),
    ...(Number.isFinite(nodeTotal) ? { nodeTotal } : {}),
    ...(Number.isFinite(detailStep) ? { detailStep } : {}),
    ...(Number.isFinite(detailStepMax) ? { detailStepMax } : {}),
  };
  const now = Date.now();
  const lastPersist = queueProgressPersistAt.get(job.id) || 0;
  if (now - lastPersist >= 500 || Number(progress.value) >= Number(progress.max || 100)) {
    queueProgressPersistAt.set(job.id, now);
    writeQueueJobs();
  }
  emit("progress", { ...job.progress, jobId: job.id });
  emitQueue();
}

function reportProgress(jobId, progress) {
  if (jobId) {
    const job = readQueueJobs().find((item) => item.id === jobId);
    if (job) {
      setJobProgress(job, progress);
      return;
    }
    if (activeCutoutBatch?.items?.has(jobId)) {
      const item = activeCutoutBatch.items.get(jobId);
      emit("cutout-progress", {
        batchId: activeCutoutBatch.id,
        itemId: jobId,
        index: item.index,
        total: activeCutoutBatch.total,
        ...progress,
      });
      emit("status", `抠图处理中 ${item.index + 1}/${activeCutoutBatch.total}：${progress.label || "处理中"}`);
      return;
    }
  }
  emit("progress", { ...progress, ...(jobId ? { jobId } : {}) });
}

async function stageQueueMedia(jobId, media, recoveryDir = "") {
  const targetDir = path.join(queueInputDir(jobId), recoveryDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const staged = [];
  try {
    for (const item of media || []) {
      const source = path.resolve(String(item || ""));
      if (!String(item || "").trim() || !fs.existsSync(source)) throw new Error(`找不到输入文件：${path.basename(source)}`);
      const target = path.join(targetDir, `${String(staged.length).padStart(2, "0")}_${path.basename(source)}`);
      fs.copyFileSync(source, target);
      staged.push(target);
    }
    return staged;
  } catch (error) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

const imageFilePattern = /\.(png|jpe?g|webp|avif)$/i;

function assetLibraryDir() {
  return path.join(rootDir(), "user", "assets");
}

function stageAssetFile(filePath) {
  const source = path.resolve(String(filePath || "").trim());
  if (!source || !fs.existsSync(source)) throw new Error("找不到素材文件");
  if (!imageAssetPattern.test(source)) throw new Error("素材库仅支持图片文件");
  if (!fs.statSync(source).isFile() || fs.statSync(source).size > 50 * 1024 * 1024) throw new Error("图片必须小于 50 MB");
  const targetDir = assetLibraryDir();
  fs.mkdirSync(targetDir, { recursive: true });
  if (isWithin(targetDir, source)) {
    return { ok: true, path: source, fileUrl: pathToFileURL(source).href, name: path.basename(source) };
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const target = path.join(targetDir, `${digest}${path.extname(source).toLowerCase()}`);
  if (!fs.existsSync(target)) fs.copyFileSync(source, target);
  stagedAssetTimes.set(target.toLowerCase(), Date.now());
  preferences.registerAsset(source, target);
  return { ok: true, path: target, fileUrl: pathToFileURL(target).href, name: path.basename(source) };
}

function pruneUnusedAssets(removedPaths = []) {
  const directory = assetLibraryDir();
  if (!fs.existsSync(directory)) return { ok: true, removed: 0, kept: 0 };
  const referenced = new Set();
  const collect = (value) => {
    if (typeof value === "string") {
      try {
        const candidate = value.startsWith("file:") ? fileURLToPath(value) : value;
        if (path.isAbsolute(candidate)) referenced.add(path.resolve(candidate).toLowerCase());
      } catch (_) {}
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  for (const [key, value] of Object.entries(preferences.values())) {
    if (key === "minimax-h3-asset-copies-v1") continue;
    try { collect(JSON.parse(value)); } catch (_) {}
  }
  collect(readQueueJobs());
  collect(activeCutoutBatch?.sourceMedia || []);
  const requested = new Set(removedPaths.map((item) => path.resolve(String(item)).toLowerCase()));
  let removed = 0;
  let kept = 0;
  const errors = [];
  const realRoot = fs.realpathSync(rootDir());
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !imageAssetPattern.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const key = target.toLowerCase();
    if (referenced.has(key) || (!requested.has(key) && Date.now() - (stagedAssetTimes.get(key) || 0) < 60000)) { kept += 1; continue; }
    try {
      if (!isWithin(realRoot, fs.realpathSync(target))) continue;
      fs.unlinkSync(target);
      stagedAssetTimes.delete(key);
      removed += 1;
    } catch (error) { errors.push(`${entry.name}：${error.message}`); }
  }
  return { ok: !errors.length, removed, kept, error: errors.join("；") };
}

function normalizeReferenceAsset(asset, index) {
  const value = asset && typeof asset === "object" ? asset : { filePath: asset };
  if (value.type && value.type !== "image") throw new Error("参考生视频仅支持图片");
  const assetId = String(value.assetId || value.id || `reference-${index + 1}`);
  const filePath = String(value.filePath || value.path || value.sourcePath || "").trim();
  if (!filePath) throw new Error(`参考图 ${index + 1} 缺少文件路径`);
  return { ...value, assetId, id: assetId, type: "image", filePath };
}

async function stageReferenceAssets(jobId, assets, recoveryDir = "") {
  const targetDir = path.join(queueInputDir(jobId), recoveryDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const staged = [];
  try {
    for (let index = 0; index < (assets || []).length; index += 1) {
      const normalized = normalizeReferenceAsset(assets[index], index);
      const source = path.resolve(normalized.filePath);
      if (!fs.existsSync(source)) throw new Error(`找不到参考图片：${path.basename(source)}`);
      if (!imageFilePattern.test(source)) throw new Error(`参考生视频仅支持图片：${path.basename(source)}`);
      const target = path.join(targetDir, `${String(index).padStart(2, "0")}_${path.basename(source)}`);
      fs.copyFileSync(source, target);
      staged.push({ ...normalized, type: "image", index: index + 1, sourcePath: source, filePath: target, modelToken: `<Picture ${index + 1}>` });
    }
    return staged;
  } catch (error) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function cleanupQueueMedia(job) {
  if (queueInputsUsedByDraft(job.id)) return;
  try { fs.rmSync(queueInputDir(job.id), { recursive: true, force: true }); } catch (_) {}
}

function freePort(start = 8188) {
  return new Promise((resolve, reject) => {
    const probe = (candidate) => {
      const server = http.createServer();
      server.once("error", () => probe(candidate + 1));
      server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(candidate)));
    };
    probe(start);
    setTimeout(() => reject(new Error("没有可用的本地端口")), 3000);
  });
}

function emit(channel, value) { integrationJobs?.progress(channel, value); if (win && !win.isDestroyed()) win.webContents.send(channel, value); }

function getIntegrationJobs() {
  if (!integrationJobs) integrationJobs = createIntegrationJobs({ rootDir, writeText: atomicWriteText,
    isBusy: () => Boolean(activeQueueJobId || activeCutoutBatch || activeAiTool || voiceService?.busy || activeTask.promptId || updateInProgress),
    operations: Object.fromEntries(["enhance", "image-enhance", "interpolate", "understand", "segment"].map(kind => [kind, payload => runAiTool({ ...payload, kind })]).concat([
      ["voice", payload => getVoiceService().generate(payload)], ["cutout-batch", payload => runCutoutBatch({ ...payload, workflow: "cutout" })],
    ])),
    cancel: async kind => {
      if (kind === "voice") return getVoiceService().cancel();
      if (kind === "cutout-batch") {
        if (!activeCutoutBatch?.task) throw new Error("任务当前不可取消");
        activeCutoutBatch.canceled = true;
        activeCutoutBatch.task.canceled = true;
        if (activeCutoutBatch.task.promptId) await cancelPrompt(requestJson, activeCutoutBatch.task.promptId);
        activeCutoutBatch.task.ws?.close();
        return { ok: true };
      }
      if (!activeAiTool) throw new Error("任务当前不可取消");
      activeAiTool.canceled = true;
      if (activeAiTool.promptId) await cancelPrompt(requestJson, activeAiTool.promptId);
      return { ok: true };
    },
  });
  return integrationJobs;
}

const integrationActionHandlers = {
  "queue.pause": "pause-queue", "queue.resume": "resume-queue", "queue.retry": "retry-queue-item", "queue.reorder": "reorder-queue-item", "queue.remove": "remove-queue-item", "queue.clear": "clear-queue",
  "workflow.get": "load-workflow-config", "workflow.save": "save-workflow-config", "workflow.reset": "reset-workflow-config", "workflow.backups": "list-workflow-backups", "workflow.restore": "restore-workflow-backup", "workflow.preflight": "preflight-workflow",
  "engine.health": "engine-health", "storage.usage": "storage-usage", "preferences.get": "load-preferences", "preferences.set": "save-preference",
  "queue.retention.get": "queue-retention-days", "queue.retention.set": "set-queue-retention-days", "asset.stage": "stage-asset", "asset.prune": "prune-assets", "reference.capabilities": "reference-capabilities",
  "voice.delete": "delete-voice", "voice.clear": "clear-voices", "cutout.delete": "delete-cutout", "cutout.clear": "clear-cutouts", "video.favorite": "set-video-favorite", "video.rename": "rename-video", "video.delete": "delete-video", "video.clear": "clear-videos",
};
async function runIntegrationAction(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(integrationActionHandlers, body.action)) throw new Error("未知管理操作，请查询 capabilities.actions");
  const args = body.args ?? [];
  if (!Array.isArray(args)) throw new Error("args 必须是参数数组");
  if (/(?:delete|clear|remove|reset|restore|prune)$/.test(body.action) && body.confirm !== true) throw new Error("此操作需要 confirm:true，执行前请确认目标和范围");
  const result = await studioHandlers.get(integrationActionHandlers[body.action])({ integration: true }, ...args);
  if (result?.ok === false) throw new Error(result.error || "操作未完成");
  return result ?? { ok: true };
}

const integrationKinds = ["enhance", "image-enhance", "interpolate", "understand", "segment", "voice", "cutout-batch"];

// Local integration API for Claude and other desktop automation clients. It is
// deliberately bound to loopback and protected by a per-launch bearer token.
// The descriptor is written under App/user so a companion MCP process can find
// the current port and token without exposing either value in command arguments.
function studioApiDescriptorPath() {
  return path.join(rootDir(), "user", "studio-api.json");
}

function studioApiJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "http://127.0.0.1",
  });
  response.end(body);
}

function studioApiAuthorized(request) {
  const header = String(request.headers.authorization || "");
  const token = header.replace(/^Bearer\s+/i, "").trim() || String(request.headers["x-studio-token"] || "").trim();
  return Boolean(studioApiToken && token && token === studioApiToken);
}

function studioApiReadBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) request.destroy(new Error("请求体过大"));
    });
    request.on("end", () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(`JSON 格式不正确：${error.message}`)); }
    });
    request.on("error", reject);
  });
}

function studioApiJob(jobId) {
  const jobs = readQueueJobs();
  const index = jobs.findIndex((item) => item.id === String(jobId || ""));
  return index < 0 ? null : publicQueueJob(jobs[index], index + 1);
}

async function handleStudioApi(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Access-Control-Allow-Origin": "http://127.0.0.1", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Studio-Token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    return response.end();
  }
  if (!url.pathname.startsWith("/api/v1/")) return studioApiJson(response, 404, { ok: false, error: "接口不存在" });
  if (!studioApiAuthorized(request)) return studioApiJson(response, 401, { ok: false, error: "缺少或无效的本机 API token" });
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/capabilities") {
      return studioApiJson(response, 200, { ok: true, api: "v1", tools: integrationKinds, workflows: ["t2v", "i2v", "r2v", "continuation", "multiframe", "control"], ai: aiToolState(), voice: getVoiceService().state(), styles: generationStyles,
        actions: Object.keys(integrationActionHandlers) });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/tasks") return studioApiJson(response, 200, { ok: true, jobs: getIntegrationJobs().list() });
    if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
      const body = await studioApiReadBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求必须是 JSON 对象");
      const job = getIntegrationJobs().submit(body.kind, body.input || {}, String(request.headers["idempotency-key"] || ""));
      return studioApiJson(response, 202, { ok: true, job });
    }
    const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)(\/cancel)?$/);
    if (taskMatch && request.method === "GET" && !taskMatch[2]) {
      const job = getIntegrationJobs().get(decodeURIComponent(taskMatch[1]));
      return studioApiJson(response, job ? 200 : 404, job ? {ok:true, job} : {ok:false,error:"找不到任务"});
    }
    if (taskMatch && request.method === "POST" && taskMatch[2]) return studioApiJson(response, 200, {ok:true,job:await getIntegrationJobs().stop(decodeURIComponent(taskMatch[1]))});
    if (request.method === "GET" && url.pathname === "/api/v1/outputs") return studioApiJson(response, 200, {ok:true,videos:listVideoFiles(100),voices:getVoiceService().list(),cutouts:cutoutService?.list() || [],tasks:getIntegrationJobs().list().filter(j=>j.result)});
    if (request.method === "POST" && url.pathname === "/api/v1/actions") {
      const body = await studioApiReadBody(request);
      return studioApiJson(response, 200, {ok:true,result:await runIntegrationAction(body)});
    }
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return studioApiJson(response, 200, { ok: true, version: app.getVersion(), engineReady: backendReady, api: "v1" });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/queue") {
      return studioApiJson(response, 200, { ok: true, jobs: queueSnapshot(), paused: queuePaused });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/videos") {
      return studioApiJson(response, 200, { ok: true, videos: listVideoFiles(100) });
    }
    const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const job = studioApiJob(decodeURIComponent(jobMatch[1]));
      return job ? studioApiJson(response, 200, { ok: true, job }) : studioApiJson(response, 404, { ok: false, error: "找不到任务" });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/generate") {
      const payload = await studioApiReadBody(request);
      const result = await enqueueWorkflow(payload);
      return studioApiJson(response, result?.ok === false ? 400 : 202, result);
    }
    const cancelMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const jobId = decodeURIComponent(cancelMatch[1]);
      const job = readQueueJobs().find((item) => item.id === jobId);
      if (!job || ["completed", "failed", "cancelled"].includes(job.state)) return studioApiJson(response, 409, { ok: false, error: "任务当前不可取消" });
      if (job.id === activeQueueJobId) {
        const task = activeTask;
        job.cancelRequested = true;
        task.canceled = true;
        if (task.preparation) task.preparation.kill();
        if (task.promptId) await cancelPrompt(requestJson, task.promptId);
        if (task.ws) task.ws.close();
      } else {
        job.state = "cancelled";
        job.error = "已取消";
        job.progress = { value: 0, max: 100, label: "已取消" };
        writeQueueJobs();
        emitQueue();
      }
      return studioApiJson(response, 200, { ok: true, job: studioApiJob(jobId) });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/openapi.json") {
      return studioApiJson(response, 200, studioApiOpenApi());
    }
    return studioApiJson(response, 404, { ok: false, error: "接口不存在" });
  } catch (error) {
    return studioApiJson(response, 400, { ok: false, error: error.message || "接口调用失败" });
  }
}

function studioApiOpenApi() {
  const spec = {
    openapi: "3.0.3",
    info: { title: "MiniMax H3 Studio Local API", version: "1.1.0" },
    servers: [{ url: `http://127.0.0.1:${studioApiPort}` }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/capabilities": { get: { summary: "模型状态、工具、工作流和管理能力" } },
      "/api/v1/tasks": { get: { summary: "所有集成工具任务" }, post: { summary: "异步执行图片/视频增强、补帧、分割、理解、语音或批量抠图", requestBody: { required: true, content: { "application/json": { schema: { type:"object", required:["kind","input"], properties:{kind:{type:"string",enum:integrationKinds},input:{type:"object"}} } } } } } },
      "/api/v1/tasks/{id}": { get: { summary: "查询进度、状态、结果与输出路径" } },
      "/api/v1/tasks/{id}/cancel": { post: { summary: "仅取消此 API 任务" } },
      "/api/v1/outputs": { get: { summary: "视频、语音、抠图与工具任务结果" } },
      "/api/v1/actions": { post: { summary: "非交互式队列、配置、历史与存储管理；详见 capabilities.actions" } },
      "/api/v1/health": { get: { summary: "检查软件和本地引擎状态" } },
      "/api/v1/queue": { get: { summary: "读取视频队列" } },
      "/api/v1/jobs/{id}": { get: { summary: "读取任务状态" } },
      "/api/v1/jobs/{id}/cancel": { post: { summary: "取消任务" } },
      "/api/v1/videos": { get: { summary: "列出已生成视频" } },
      "/api/v1/generate": { post: { summary: "提交视频生成任务", description: "workflow 可用 t2v、i2v、r2v、continuation、multiframe、control。media 使用本机绝对路径。" } },
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
  const jsonSchema = { type: "object", additionalProperties: true };
  for (const [route, methods] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(methods)) {
    operation.responses = {
      [method === "post" && ["/api/v1/tasks", "/api/v1/generate"].includes(route) ? "202" : "200"]: { description: "成功；异步任务返回 job.id，按 ID 轮询直至终态", content: { "application/json": { schema: jsonSchema } } },
      "400": { description: "无效参数、引擎忙或操作失败", content: { "application/json": { schema: jsonSchema } } },
      "401": { description: "缺少或无效的本机 token" }, "404": { description: "接口或任务不存在" }, "409": { description: "任务状态不允许此操作" },
    };
    if (route.includes("{id}")) operation.parameters = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
  }
  const body = schema => ({ required: true, content: { "application/json": { schema } } });
  spec.paths["/api/v1/actions"].post.requestBody = body({ type:"object", required:["action"], properties:{ action:{type:"string",enum:Object.keys(integrationActionHandlers)}, args:{type:"array",items:{},description:"有序参数数组，见 CLI Skill references/api.md"}, confirm:{type:"boolean",default:false} } });
  spec.paths["/api/v1/generate"].post.requestBody = body({type:"object",required:["workflow","prompt"],properties:{ workflow:{type:"string",enum:["t2v","i2v","r2v","continuation","multiframe","control"]},prompt:{type:"string"},media:{type:"array",items:{type:"string"}},referenceAssets:{type:"array",items:jsonSchema},settings:jsonSchema }});
  spec.paths["/api/v1/tasks"].post.parameters = [{name:"Idempotency-Key",in:"header",schema:{type:"string",maxLength:128},description:"同键同参数返回原任务；同键不同参数拒绝"}];
  spec.paths["/api/v1/tasks"].post.requestBody = body({type:"object",required:["kind","input"],properties:{kind:{type:"string",enum:integrationKinds},input:{type:"object",properties:{file:{type:"string",description:"本机绝对路径"},prompt:{type:"string"},multiplier:{type:"integer",enum:[2,3,4]},segmentMode:{type:"string",enum:["automatic","interactive"]},segmentPrompts:jsonSchema,text:{type:"string"},engine:{type:"string",enum:["kokoro","melo"]},voice:{type:"string"},speed:{type:"number"},media:{type:"array",items:{type:"string"}}}}}});
  return spec;
}

async function startStudioApi() {
  if (studioApiServer) return;
  studioApiPort = await freePort(18480);
  studioApiToken = crypto.randomBytes(24).toString("hex");
  const root = rootDir();
  getIntegrationJobs().list();
  fs.mkdirSync(path.join(root, "user"), { recursive: true });
  atomicWriteText(studioApiDescriptorPath(), JSON.stringify({ api: "v1", baseUrl: `http://127.0.0.1:${studioApiPort}`, port: studioApiPort, token: studioApiToken, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  studioApiServer = http.createServer((request, response) => { handleStudioApi(request, response).catch((error) => studioApiJson(response, 500, { ok: false, error: error.message || "接口内部错误" })); });
  await new Promise((resolve, reject) => { studioApiServer.once("error", reject); studioApiServer.listen(studioApiPort, "127.0.0.1", resolve); });
  emit("status", `H3 本机接口已就绪：127.0.0.1:${studioApiPort}`);
}

function stopStudioApi() {
  if (studioApiServer) { try { studioApiServer.close(); } catch (_) {} }
  studioApiServer = null;
  studioApiPort = 0;
  studioApiToken = "";
  try { fs.rmSync(studioApiDescriptorPath(), { force: true }); } catch (_) {}
}

function githubRequest(route) {
  return new Promise((resolve, reject) => {
    const target = /^https?:\/\//i.test(String(route || "")) ? String(route) : `https://api.github.com${route}`;
    const request = https.get(target, { headers: { "User-Agent": "MiniMax-H3-Studio", Accept: "application/vnd.github+json" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(githubRequest(response.headers.location));
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`GitHub 返回 ${response.statusCode}`);
          error.statusCode = response.statusCode;
          return reject(error);
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(10000, () => request.destroy(new Error("更新检查超时")));
  });
}

function versionParts(value) {
  return String(value || "0").replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const next = versionParts(candidate);
  const previous = versionParts(current);
  for (let i = 0; i < Math.max(next.length, previous.length); i += 1) {
    if ((next[i] || 0) !== (previous[i] || 0)) return (next[i] || 0) > (previous[i] || 0);
  }
  return false;
}

function latestRelease() {
  return githubRequest(`/repos/${UPDATE_REPO}/releases/latest`);
}

function isUpdateAsset(assetName) {
  return path.basename(String(assetName || "")).toLowerCase().replace(/[._\s-]+/g, "") === "minimaxh3studioexe";
}

function downloadFile(url, destination, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("更新下载重定向过多"));
    const request = https.get(url, { headers: { "User-Agent": "MiniMax-H3-Studio", Accept: "application/octet-stream" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(downloadFile(response.headers.location, destination, redirectCount + 1));
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`更新下载失败（${response.statusCode}）`));
      }
      const stream = fs.createWriteStream(destination);
      response.pipe(stream);
      stream.on("finish", () => stream.close(resolve));
      stream.on("error", (error) => { stream.destroy(); reject(error); });
    });
    request.on("error", reject);
    request.setTimeout(120000, () => request.destroy(new Error("更新下载超时")));
  });
}

function verifyUpdateAsset(filePath, asset) {
  const stat = fs.statSync(filePath);
  if (stat.size < 1024 * 1024) throw new Error("更新包大小异常");
  const header = Buffer.alloc(2);
  const fd = fs.openSync(filePath, "r");
  try { fs.readSync(fd, header, 0, 2, 0); } finally { fs.closeSync(fd); }
  if (header.toString("ascii") !== "MZ") throw new Error("更新包不是有效的 Windows 程序");
  const digest = String(asset?.digest || "");
  if (digest.startsWith("sha256:")) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (actual.toLowerCase() !== digest.slice(7).toLowerCase()) throw new Error("更新包校验失败");
  }
}

async function getUpdateInfo() {
  const currentVersion = app.getVersion();
  const release = await latestRelease();
  const latestVersion = String(release.tag_name || release.name || "").replace(/^v/i, "");
  const asset = (release.assets || []).find((item) => isUpdateAsset(item.name));
  return { currentVersion, latestVersion, hasUpdate: Boolean(asset && latestVersion && isNewerVersion(latestVersion, currentVersion)), assetName: asset?.name || "", releaseUrl: release.html_url || "", notes: release.body || "" };
}

function requestJson(method, route, body) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error("本地引擎尚未就绪"));
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
      let chunks = "";
      res.on("data", (chunk) => chunks += chunk);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let error = `本地引擎返回 ${res.statusCode}`;
          try { error = describeEngineError(JSON.parse(chunks), error); } catch (_) {}
          return reject(new Error(error));
        }
        try { resolve(JSON.parse(chunks || "{}")); } catch (error) { reject(new Error(`本地引擎响应格式错误：${error.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("本地引擎请求超时")));
    if (data) req.write(data);
    req.end();
  });
}

function aiToolState() {
  const root = rootDir();
  const base = path.join(root, "models");
  const requirements = {
    enhance: [path.join(base, "upscale_models", "RealESRGAN_x4plus.safetensors")],
    "image-enhance": [path.join(base, "upscale_models", "RealESRGAN_x4plus.safetensors")],
    interpolate: [path.join(base, "frame_interpolation", "film_net_fp16.safetensors")],
    understand: [path.join(base, "text_encoders", "qwen3vl_4b_fp8_scaled.safetensors")],
  };
  const checks = Object.fromEntries(Object.entries(requirements).map(([id, files]) => [id, files.every(fs.existsSync)]));
  checks.segment = fs.existsSync(path.join(base, "sams", "mobile_sam.pt"));
  return { ready: Boolean(backendReady && port), models: checks, missing: Object.fromEntries(Object.entries(requirements).map(([id, files]) => [id, files.filter(file => !fs.existsSync(file)).map(file => path.relative(root, file).replace(/\\/g, "/"))])) };
}

async function runAiTool(payload = {}) {
  if (updateInProgress) throw new Error("正在更新软件，请稍候");
  if (!backendReady || !port) throw new Error("本地引擎尚未就绪");
  if (activeQueueJobId || activeCutoutBatch || activeAiTool || voiceService?.busy || activeTask.promptId) throw new Error("本地引擎正忙，请等当前任务完成后再试");
  const kind = String(payload.kind || "");
  if (!["enhance", "image-enhance", "interpolate", "understand", "segment"].includes(kind)) throw new Error("请选择有效的 AI 工具");
  const file = path.resolve(String(payload.file || ""));
  const imageTool = ["understand", "segment", "image-enhance"].includes(kind);
  const isVideo = /\.(mp4|mov|mkv|webm|avi)$/i.test(file);
  if (!fs.existsSync(file) || (imageTool ? !imageAssetPattern.test(file) : !isVideo)) throw new Error(imageTool ? "请选择有效图片" : "请选择有效视频");
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("请选择文件");
  if (stat.size > (imageTool ? 50 * 1024 * 1024 : 1024 * 1024 * 1024)) throw new Error(imageTool ? "图片不能超过 50 MB" : "视频不能超过 1 GB");
  const multiplier = Number(payload.multiplier ?? 2);
  if (kind === "interpolate" && (!Number.isInteger(multiplier) || multiplier < 2 || multiplier > 4)) throw new Error("补帧倍率必须是 2、3 或 4");
  const state = aiToolState();
  if (!state.models[kind]) throw new Error("所需模型尚未安装，请先完成 AI 工具模型安装");
  const task = { kind, promptId: null, ws: null, canceled: false, startedAt: Date.now() };
  activeAiTool = task;
  const id = crypto.randomUUID();
  const root = rootDir();
  const inputName = `ai_${id}${path.extname(file).toLowerCase()}`;
  const inputPath = path.join(root, "input", inputName);
  const outputPrefix = `ai-tools/${kind}-${id.slice(0, 8)}`;
  const report = (label, value, extra = {}) => emit("ai-tool-progress", { kind, label, value, max: 100, canceled: task.canceled, ...extra });
  let socket;
  try {
    fs.copyFileSync(file, inputPath);
    let graph;
    if (kind === "enhance") graph = {
      1: { class_type: "LoadVideo", inputs: { file: inputName } },
      2: { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
      3: { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4plus.safetensors" } },
      4: { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["3", 0], image: ["2", 0] } },
      5: { class_type: "CreateVideo", inputs: { images: ["4", 0], fps: ["2", 2], audio: ["2", 1], bit_depth: ["2", 3], color_space: ["2", 4] } },
      6: { class_type: "SaveVideo", inputs: { video: ["5", 0], filename_prefix: outputPrefix, format: "mp4" } },
    };
    else if (kind === "image-enhance") graph = {
      1: { class_type: "LoadImage", inputs: { image: inputName } },
      2: { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4plus.safetensors" } },
      3: { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
      4: { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: outputPrefix } },
    };
    else if (kind === "interpolate") graph = {
      1: { class_type: "LoadVideo", inputs: { file: inputName } },
      2: { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
      3: { class_type: "FrameInterpolationModelLoader", inputs: { model_name: "film_net_fp16.safetensors" } },
      4: { class_type: "FrameInterpolate", inputs: { interp_model: ["3", 0], images: ["2", 0], multiplier } },
      5: { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: ["7", 0], audio: ["2", 1], bit_depth: ["2", 3], color_space: ["2", 4] } },
      6: { class_type: "SaveVideo", inputs: { video: ["5", 0], filename_prefix: outputPrefix, format: "mp4" } },
      7: { class_type: "ComfyMathExpression", inputs: { expression: `a * ${multiplier}`, "values.a": ["2", 2] } },
      8: { class_type: "ImageFromBatch", inputs: { image: ["2", 0], batch_index: -1, length: 1 } },
      9: { class_type: "RepeatImageBatch", inputs: { image: ["8", 0], amount: multiplier - 1 } },
      10: { class_type: "ImageBatch", inputs: { image1: ["4", 0], image2: ["9", 0] } },
    };
    else if (kind === "understand") graph = {
      1: { class_type: "LoadImage", inputs: { image: inputName } },
      2: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "stable_diffusion" } },
      3: { class_type: "TextGenerate", inputs: { clip: ["2", 0], image: ["1", 0], prompt: String(payload.prompt || "请用中文详细描述图片中的主体、场景、动作、构图、颜色和可见文字。").slice(0, 1000), max_length: 384, sampling_mode: "on", "sampling_mode.temperature": 0.7, "sampling_mode.top_k": 40, "sampling_mode.top_p": 0.9, "sampling_mode.min_p": 0.05, "sampling_mode.repetition_penalty": 1.05, "sampling_mode.presence_penalty": 0, "sampling_mode.seed": 1234, thinking: false, use_default_template: true, mtp: "off" } },
      4: { class_type: "PreviewAny", inputs: { source: ["3", 0] } },
    };
    else if (kind === "segment" && payload.segmentMode !== "automatic") {
      const prompts = validateSegmentPrompts(payload.segmentPrompts);
      graph = {
        1: { class_type: "LoadImage", inputs: { image: inputName } },
        2: { class_type: "H3InteractiveSegment", inputs: { image: ["1", 0], prompts: JSON.stringify(prompts), model_path: path.join(root, "models", "sams", "mobile_sam.pt") } },
        3: { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: outputPrefix } },
      };
    }
    else {
      const cutoutConfig = readWorkflowConfig("cutout");
      if (!cutoutConfig.ok) throw new Error(cutoutConfig.error || "本地抠图工作流尚未就绪");
      graph = JSON.parse(cutoutConfig.content);
      if (!Object.values(graph).some(node => node.class_type === "InspyrenetRembg")) throw new Error("当前抠图工作流不支持智能分割");
      const load = Object.values(graph).find(node => node.class_type === "LoadImage");
      if (load) load.inputs.image = inputName;
      const save = Object.values(graph).find(node => node.class_type === "SaveImage");
      if (save) save.inputs.filename_prefix = outputPrefix;
      const selection = payload.selection;
      if (selection && (!["x", "y", "width", "height", "imageWidth", "imageHeight"].every(key => Number.isFinite(selection[key])) || selection.x < 0 || selection.y < 0 || selection.width <= 0 || selection.height <= 0 || selection.x + selection.width > 1.000001 || selection.y + selection.height > 1.000001 || selection.imageWidth < 1 || selection.imageHeight < 1)) throw new Error("框选区域无效，请重新框选");
      const removerEntry = Object.entries(graph).find(([, node]) => node.class_type === "InspyrenetRembg");
      const loaderEntry = Object.entries(graph).find(([, node]) => node.class_type === "LoadImage");
      if (selection && removerEntry && loaderEntry && Number.isFinite(selection.imageWidth) && Number.isFinite(selection.imageHeight)) {
        const imageWidth = Math.max(1, Math.floor(selection.imageWidth));
        const imageHeight = Math.max(1, Math.floor(selection.imageHeight));
        const x = Math.max(0, Math.min(imageWidth - 1, Math.floor(selection.x * imageWidth)));
        const y = Math.max(0, Math.min(imageHeight - 1, Math.floor(selection.y * imageHeight)));
        const width = Math.max(1, Math.min(imageWidth - x, Math.ceil(selection.width * imageWidth)));
        const height = Math.max(1, Math.min(imageHeight - y, Math.ceil(selection.height * imageHeight)));
        if (width >= 2 && height >= 2) {
          graph.ai_crop = { class_type: "ImageCrop", inputs: { image: [String(loaderEntry[0]), 0], width, height, x, y } };
          removerEntry[1].inputs.image = ["ai_crop", 0];
        }
      }
    }
    report("正在准备本地任务", 2);
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=ai-tool-${id}`);
    task.ws = socket;
    socket.on("error", () => {});
    let promptId = "";
    let executionError = "";
    socket.on("message", raw => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.data?.prompt_id !== promptId) return;
        if (event.type === "execution_error") executionError = event.data.exception_message || "本地任务执行失败";
        if (event.type === "executing" && event.data.node) report("本地模型处理中", 10, { nodeId: String(event.data.node) });
      } catch (_) {}
    });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("连接本地引擎超时")), 10000); socket.once("open", () => { clearTimeout(timer); resolve(); }); socket.once("error", () => { clearTimeout(timer); reject(new Error("无法连接本地引擎")); }); });
    const submitted = await requestJson("POST", "/prompt", { prompt: graph, client_id: `ai-tool-${id}` });
    if (submitted.error || !submitted.prompt_id) throw new Error(describeEngineError(submitted, "本地任务提交失败"));
    promptId = submitted.prompt_id; task.promptId = promptId;
    if (task.canceled) { await cancelPrompt(requestJson, promptId); throw new Error("任务已取消"); }
    report("正在执行本地模型", 5, { promptId });
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
      if (task.canceled) { await cancelPrompt(requestJson, promptId); throw new Error("任务已取消"); }
      const history = await requestJson("GET", `/history/${encodeURIComponent(promptId)}`);
      if (task.canceled) { await cancelPrompt(requestJson, promptId); throw new Error("任务已取消"); }
      const record = history[promptId];
      if (record) {
        if (["error", "execution_error"].includes(record.status?.status_str)) throw new Error(describeEngineError(record, executionError || "本地任务失败，请查看 logs/backend.log"));
        const outputs = Object.values(record.outputs || {});
        const image = outputs.flatMap(value => value.images || []).find(value => value.type === "output");
        const videoPath = savedVideoPaths(record, graph, path.join(root, "output"), fs.existsSync)[0];
        const textValues = outputs.flatMap(value => value.text || []);
        const text = textValues.map(value => typeof value === "string" ? value : String(value?.text || "")).join("\n").trim() || String(record.outputs?.["3"]?.string?.[0] || "").trim();
        let resultPath = "";
        if (videoPath) resultPath = videoPath;
        else if (image?.filename) resultPath = path.join(root, "output", image.subfolder || "", image.filename);
        if (resultPath && !isWithin(path.join(root, "output"), resultPath)) throw new Error("引擎返回了无效的输出路径");
        if ((kind === "enhance" || kind === "image-enhance" || kind === "interpolate" || kind === "segment") && (!resultPath || !fs.existsSync(resultPath))) throw new Error("任务已结束，但没有找到输出文件；请查看 logs/backend.log");
        if (kind === "understand" && !text) throw new Error("图片理解没有返回文字结果；请查看 logs/backend.log");
        if (kind === "understand" && !/[\p{L}\p{N}]/u.test(text)) throw new Error("图像理解返回了无效内容（只有标点），请检查识图模型，当前结果未作为成功输出");
        report("处理完成", 100, { resultPath, text });
        return { ok: true, resultPath, text, ...((kind === "segment" || kind === "image-enhance") && resultPath ? { previewUrl: pathToFileURL(resultPath).href } : {}) };
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
      report("本地模型处理中", Math.min(95, 8 + Math.round((Date.now() - task.startedAt) / 18000)));
    }
    throw new Error("本地处理超时");
  } catch (error) {
    if (task.promptId) await cancelPrompt(requestJson, task.promptId).catch(() => {});
    report(task.canceled ? "任务已取消" : "处理失败", 0, { error: error.message });
    throw error;
  } finally {
    try { socket?.close(); } catch (_) {}
    try { fs.unlinkSync(inputPath); } catch (_) {}
    if (activeAiTool === task) activeAiTool = null;
    processQueue();
  }
}

async function startBackend() {
  if (process.platform !== "win32") throw new Error("当前便携引擎仅支持 Windows x64 + NVIDIA CUDA");
  const root = rootDir();
  const python = path.join(root, "python", "python.exe");
  const main = path.join(root, "ComfyUI", "main.py");
  if (!fs.existsSync(python) || !fs.existsSync(main)) throw new Error("便携包不完整，找不到 ComfyUI 或 Python");
  const segmentNode = app.isPackaged ? path.join(process.resourcesPath, "runtime", "h3_interactive_segment.py") : path.join(__dirname, "h3_interactive_segment.py");
  fs.copyFileSync(segmentNode, path.join(root, "ComfyUI", "custom_nodes", "h3_interactive_segment.py"));
  port = await freePort();
  backendReady = false;
  objectInfoCache = { at: 0, data: null };
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.mkdirSync(path.join(root, "user"), { recursive: true });
  fs.mkdirSync(path.join(root, "input"), { recursive: true });
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  // Keep the cutout model inside the portable App directory. This avoids
  // relying on the developer machine's user home/cache when the app is moved.
  const cutoutModelDir = path.join(root, "user", ".transparent-background");
  fs.mkdirSync(cutoutModelDir, { recursive: true });
  pruneRuntimeDatabases();
  backendLogFd = openLog(path.join(root, "logs", "backend.log"));
  // Each app launch gets its own SQLite file. This prevents a stale ComfyUI
  // child left behind by a crash from locking the next launch out of the DB.
  backendDbPath = path.join(root, "user", `comfyui-${process.pid}.db`);
  const dbUrl = `sqlite:///${backendDbPath.replace(/\\/g, "/")}`;
  backend = spawn(python, [main, "--windows-standalone-build", "--disable-auto-launch", "--listen", "127.0.0.1", "--port", String(port), "--input-directory", path.join(root, "input"), "--output-directory", path.join(root, "output"), "--user-directory", path.join(root, "user"), "--database-url", dbUrl, "--extra-model-paths-config", path.join(root, "extra_model_paths.yaml")], { cwd: root, windowsHide: true, env: { ...process.env, TRANSPARENT_BACKGROUND_FILE_PATH: path.join(root, "user") }, stdio: ["ignore", backendLogFd, backendLogFd] });
  backend.on("error", (error) => {
    backendReady = false;
    emit("status", `本地引擎启动失败：${error.message}`);
  });
  backend.on("exit", (code) => {
    backendReady = false;
    if (backendDbPath) { try { fs.rmSync(backendDbPath, { force: true }); } catch (_) {} backendDbPath = ""; }
    if (backendLogFd !== null) { try { fs.closeSync(backendLogFd); } catch (_) {} backendLogFd = null; }
    if (code && win) emit("status", `本地引擎已停止（代码 ${code}），详情见 logs/backend.log`);
  });
  for (let i = 0; i < 120; i++) {
    try { await requestJson("GET", "/system_stats"); backendReady = true; emit("status", "本地引擎已就绪"); emitQueue(); processQueue(); return; } catch (_) { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (backend && !backend.killed) backend.kill();
  throw new Error("本地引擎启动超时，请查看 logs/backend.log");
}

async function getObjectInfoSnapshot() {
  if (!backendReady || !port) return null;
  if (objectInfoCache.data && Date.now() - objectInfoCache.at < 30000) return objectInfoCache.data;
  try {
    const data = await requestJson("GET", "/object_info");
    if (!data || typeof data !== "object") return null;
    objectInfoCache = { at: Date.now(), data };
    return data;
  } catch (_) {
    return null;
  }
}

async function inspectWorkflowRuntime(graph) {
  const info = await getObjectInfoSnapshot();
  if (!info) return { errors: ["无法读取引擎节点和模型清单，请稍后重试"], warnings: [] };
  const nodes = Object.values(graph || {});
  const errors = [];
  const warnings = [];
  for (const node of nodes) {
    const classType = String(node?.class_type || "");
    if (!classType || info[classType]) continue;
    errors.push(`缺少必需节点：${classType}`);
  }
  const modelInputs = [
    ["UNETLoader", "unet_name", "UNet 模型"],
    ["CLIPLoader", "clip_name", "CLIP 模型"],
    ["VAELoader", "vae_name", "VAE 模型"],
    ["LoraLoaderModelOnly", "lora_name", "LoRA 模型"],
    ["ModelPatchLoader", "name", "控制模型"],
    ["CheckpointLoaderSimple", "ckpt_name", "姿态模型"],
  ];
  for (const [classType, inputName, label] of modelInputs) {
    const nodeInfo = info[classType];
    if (!nodeInfo) continue;
    const choices = nodeInfo?.input?.required?.[inputName]?.[0];
    if (!Array.isArray(choices) || !choices.length || choices.some((value) => typeof value !== "string")) continue;
    for (const node of nodes.filter((item) => item?.class_type === classType)) {
      const requested = String(node?.inputs?.[inputName] || "");
      if (requested && !choices.includes(requested)) errors.push(`找不到${label}：${requested}`);
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function buildPreflightWarnings({ workflowId, settings = {}, inputCount = 0, system = null } = {}) {
  const warnings = [];
  const resolution = String(settings.resolution || "standard");
  const duration = Number(settings.duration) || 5;
  if (resolution === "ultra") warnings.push("超清分辨率会明显增加显存占用和生成时间");
  else if (resolution === "hd") warnings.push("高清分辨率会比标准画质占用更多显存和时间");
  if (duration >= 8) warnings.push(`${duration} 秒时长会增加生成耗时，长任务会在队列中依次执行`);
  if (workflowId === "r2v" && inputCount > 1) warnings.push(`本次将处理 ${inputCount} 张参考图，参考图越多前处理耗时越长`);
  if (Number(settings.batchCount) > 1) warnings.push(`批量 ${Math.min(8, Math.max(1, Number(settings.batchCount) || 1))} 个任务将按顺序执行`);

  const device = Array.isArray(system?.devices) ? system.devices[0] : null;
  if (system && !device) warnings.push("未检测到可用 GPU，生成可能无法启动");
  const freeVram = Number(device?.vram_free ?? device?.torch_vram_free ?? 0);
  const totalVram = Number(device?.vram_total ?? device?.torch_vram_total ?? 0);
  if (freeVram > 0 && totalVram > 0 && freeVram / totalVram < 0.18 && resolution !== "standard") {
    warnings.push("当前可用显存偏低，建议先关闭其他占用显存的程序或降低分辨率");
  }
  return [...new Set(warnings)];
}

function loadWorkflow(name) {
  const workflowId = workflowIdFromValue(name);
  const custom = path.join(rootDir(), "user", "workflows", `${workflowId}.custom.json`);
  const file = fs.existsSync(custom) ? custom : defaultWorkflowPath(workflowId);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function workflowIdFromValue(value) {
  const text = String(value || "").trim();
  if (["i2v", "r2v", "t2v", "continuation", "multiframe", "control"].includes(text)) return text;
  const lower = text.toLowerCase();
  if (text.includes("续接") || lower.includes("continuation")) return "continuation";
  if (text.includes("多帧") || lower.includes("multiframe")) return "multiframe";
  if (text.includes("控制") || lower.includes("control")) return "control";
  if (text.includes("抠图") || lower.includes("cutout") || lower.includes("rembg")) return "cutout";
  if (text.includes("参考") || lower.includes("reference") || lower.includes("r2v")) return "r2v";
  if (text.includes("图生") || lower.includes("image") || lower.includes("i2v")) return "i2v";
  return "t2v";
}

function workflowFileName(workflowId) {
  return { i2v: "MiniMax-H3-图生视频.json", r2v: "MiniMax-H3-参考生视频.json", t2v: "MiniMax-H3-文生视频.json", cutout: "InspyrenetRembg抠图.json", continuation: "MiniMax-H3-视频续接.json", multiframe: "MiniMax-H3-多帧参考.json", control: "MiniMax-H3-控制视频.json" }[workflowId];
}

function validateWorkflowGraph(graph) {
  if (!graph || Array.isArray(graph) || typeof graph !== "object") return "工作流 JSON 格式不正确";
  const nodes = Object.values(graph);
  if (!nodes.length || nodes.length > 1000) return "工作流节点数量不合法";
  if (nodes.some((node) => !node || typeof node !== "object" || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object")) return "工作流节点格式不正确";
  if (nodes.some((node) => node.class_type === "InspyrenetRembg")) return validateCutoutGraph(graph);
  const nodeIds = new Set(Object.keys(graph));
  for (const node of nodes) {
    for (const value of Object.values(node.inputs || {})) {
      if (Array.isArray(value) && value.length >= 1 && (typeof value[0] === "string" || typeof value[0] === "number") && !nodeIds.has(String(value[0]))) return "工作流包含无效节点连接";
    }
  }
  const saveNodes = nodes.filter((node) => node.class_type === "SaveVideo");
  if (!saveNodes.length) return "工作流缺少 SaveVideo 节点";
  const h3Ids = new Set(Object.entries(graph).filter(([, node]) => ["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"].includes(node.class_type)).map(([id]) => id));
  if (!h3Ids.size) return "工作流缺少 MiniMax H3 视频节点";
  const reachesH3 = (startId, visited = new Set()) => {
    const id = String(startId || "");
    if (h3Ids.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const node = graph[id];
    if (!node) return false;
    return Object.values(node.inputs || {}).some((value) => Array.isArray(value) && typeof value[0] === "string" && reachesH3(value[0], visited));
  };
  if (!saveNodes.some((node) => Array.isArray(node.inputs?.video) && reachesH3(node.inputs.video[0]))) return "SaveVideo 未连接到 MiniMax H3 视频节点";
  return "";
}

function customWorkflowPath(workflowId) {
  return path.join(rootDir(), "user", "workflows", `${workflowId}.custom.json`);
}

function defaultWorkflowPath(workflowId) {
  const name = workflowFileName(workflowId);
  const externalPath = path.join(rootDir(), "workflows", name);
  if (fs.existsSync(externalPath)) return externalPath;
  const bundledRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
  return path.join(bundledRoot, "workflows", name);
}

function readWorkflowConfig(workflowId) {
  const id = workflowIdFromValue(workflowId);
  const customPath = customWorkflowPath(id);
  const file = fs.existsSync(customPath) ? customPath : defaultWorkflowPath(id);
  try {
    const graph = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ok: true, workflowId: id, custom: file === customPath, content: JSON.stringify(graph, null, 2) };
  } catch (error) {
    return { ok: false, workflowId: id, custom: false, content: "", error: `读取工作流失败：${error.message}` };
  }
}

function workflowBackupPath(workflowId) {
  const backupDir = path.join(rootDir(), "user", "workflows", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  return path.join(backupDir, `${workflowId}.${stamp}.json`);
}

function pruneWorkflowBackups(workflowId, keep = 10) {
  const backupDir = path.join(rootDir(), "user", "workflows", "backups");
  try {
    const prefix = `${workflowId}.`;
    const files = fs.readdirSync(backupDir).filter((name) => name.startsWith(prefix)).sort().reverse();
    for (const name of files.slice(keep)) fs.unlinkSync(path.join(backupDir, name));
  } catch (_) {}
}

function inferWorkflowFromOutput(relativeName) {
  const name = String(relativeName || "").toLowerCase();
  if (name.includes("continuation")) return "continuation";
  if (name.includes("multiframe")) return "multiframe";
  if (name.includes("control")) return "control";
  if (name.includes("r2v") || name.includes("参考")) return "r2v";
  if (name.includes("i2v") || name.includes("图生")) return "i2v";
  if (name.includes("t2v") || name.includes("文生") || name.includes("minimax_h3")) return "t2v";
  if (name.includes("cutout") || name.includes("抠图") || name.includes("rembg")) return "cutout";
  return "";
}

function listVideoFiles(limit = 100) {
  const outputDir = path.resolve(rootDir(), "output");
  if (!fs.existsSync(outputDir)) return [];
  const metadata = readStudioHistory();
  const extensions = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"]);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (extensions.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = fs.statSync(fullPath);
          const relativeName = path.relative(outputDir, fullPath).replace(/\\/g, "/");
          files.push({
            path: fullPath,
            url: pathToFileURL(fullPath).href,
            name: relativeName,
            size: stat.size,
            modified: stat.mtimeMs,
            workflow: metadata[relativeName]?.workflow || inferWorkflowFromOutput(relativeName),
            prompt: metadata[relativeName]?.prompt || "",
            duration: Number(metadata[relativeName]?.duration) || 0,
            resolution: metadata[relativeName]?.resolution || "",
            aspectRatio: metadata[relativeName]?.aspectRatio || "",
            fps: Number(metadata[relativeName]?.fps) || 0,
            seed: metadata[relativeName]?.seed ?? "",
            width: metadata[relativeName]?.width || 0,
            height: metadata[relativeName]?.height || 0,
            favorite: Boolean(metadata[relativeName]?.favorite),
          });
        } catch (_) {}
      }
    }
  };
  visit(outputDir);
  return files.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

function outputFilePath(candidate) {
  const outputDir = path.resolve(rootDir(), "output");
  const target = path.resolve(String(candidate || ""));
  const relative = path.relative(outputDir, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function readStudioHistory() {
  try {
    const filePath = path.join(rootDir(), "user", "studio-history.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("文件结构无效");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`读取视频历史失败：${error.message}。原文件已保留，请检查 user/studio-history.json`);
  }
}

function writeStudioHistory(metadata) {
  const filePath = path.join(rootDir(), "user", "studio-history.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteText(filePath, JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}, null, 2));
}

function safeFileName(value, fallback = "video") {
  const base = path.basename(String(value || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return base || fallback;
}

function verifyPythonExecutable(pythonPath, cwd) {
  return new Promise((resolve) => {
    if (!fs.existsSync(pythonPath)) return resolve({ ok: false, error: `找不到 Python：${pythonPath}` });
    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const script = "import sys,json,importlib.metadata as m\nnames=['torch','comfyui-frontend-package','comfy-kitchen','comfy-aimdo']\nversions={}\nfor name in names:\n try: versions[name]=m.version(name)\n except m.PackageNotFoundError: versions[name]=None\nprint(json.dumps({'version':sys.version.split()[0],'packages':versions}))";
    const child = spawn(pythonPath, ["-c", script], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => finish({ ok: false, error: `Python 无法启动：${error.message}` }));
    child.once("close", (code) => {
      const version = output.trim().replace(/\s+/g, " ");
      if (code === 0) {
        try { finish({ ok: true, ...JSON.parse(output.trim()) }); }
        catch (_) { finish({ ok: false, error: `Python 自检返回异常：${version}` }); }
      } else finish({ ok: false, error: `Python 启动失败（代码 ${code}）${version ? `：${version}` : ""}` });
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, error: "Python 启动超时" });
    }, 5000);
  });
}

function directorySize(directory) {
  let total = 0;
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) visit(full);
        else total += fs.statSync(full).size;
      } catch (_) {}
    }
  };
  visit(directory);
  return total;
}

function modelDirectory() {
  const portable = path.join(rootDir(), "models");
  return fs.existsSync(portable) ? portable : path.join(rootDir(), "ComfyUI", "models");
}

function isWithin(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nodeTitle(node) {
  return String(node?._meta?.title || node?.title || "").toLowerCase();
}

function isDurationNode(node) {
  return node?.class_type === "PrimitiveFloat" && /duration|时长/.test(nodeTitle(node));
}

async function prepareStudioVideo(source, target, workflowId, duration, task) {
  const helper = app.isPackaged ? path.join(process.resourcesPath, "runtime", "video-input.py") : path.join(__dirname, "video-input.py");
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(rootDir(), "python", "python.exe"), [helper, source, target, workflowId, String(duration || 5)], { windowsHide: true });
    task.preparation = child;
    let errorText = "";
    child.stderr.on("data", data => { errorText = (errorText + data).slice(-3000); });
    const timer = setTimeout(() => { child.kill(); }, 120000);
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      task.preparation = null;
      if (task.canceled) reject(new Error("任务已取消"));
      else if (code !== 0) reject(new Error(`视频读取失败：${errorText || "无法解码该视频"}`));
      else resolve();
    });
  });
}

async function runWorkflow(_event, { workflow, prompt, originalPrompt = prompt, promptParts = [], media, referenceAssets, settings = {}, workflowGraph, jobId = "", id = "" }) {
  if (activeAiTool) throw new Error("AI 工具正在处理，请完成或停止后再生成视频");
  if (voiceService?.busy) throw new Error("语音生成正在处理，请完成或停止后再提交视频任务");
  const task = { promptId: null, ws: null, canceled: false };
  activeTask = task;
  const graph = workflowGraph ? JSON.parse(JSON.stringify(workflowGraph)) : loadWorkflow(workflow);
  const progressJobId = jobId || id;
  const root = rootDir();
  const workflowId = workflowIdFromValue(workflow);
  const outputToken = String(progressJobId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "job";
  applyGenerationSettings(graph, workflowId, settings);
  prompt = styledPrompt(prompt, settings.style);
  const [width, height] = outputSize(settings);
  const aspectRatio = settings.aspectRatio === "9:16 (Portrait)" ? "9:16 (Portrait Widescreen)" : settings.aspectRatio;
  Object.values(graph).forEach((node) => {
    if (node.class_type === "ResolutionSelector") {
      if (aspectRatio) node.inputs.aspect_ratio = aspectRatio;
      node.inputs.megapixels = width * height / (1024 * 1024);
    }
    if (isDurationNode(node) && Number.isFinite(Number(settings.duration))) node.inputs.value = Number(settings.duration);
    if (node.class_type === "RandomNoise" && Number.isFinite(Number(settings.seed))) node.inputs.noise_seed = Math.max(0, Math.floor(Number(settings.seed)));
    if (node.class_type === "CreateVideo") node.inputs.fps = 24;
    if (["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"].includes(node.class_type) && Object.prototype.hasOwnProperty.call(node.inputs || {}, "negative_prompt") && settings.negativePrompt !== undefined) node.inputs.negative_prompt = String(settings.negativePrompt || "");
    if (node.class_type === "SaveVideo") node.inputs.filename_prefix = `video/${workflowId}_MiniMax_H3_${outputToken}`;
  });
  const uploaded = [];
  const cleanupUploaded = () => {
    for (const item of uploaded) {
      try { fs.unlinkSync(path.join(root, "input", item.filename)); } catch (_) {}
    }
  };
  const inputItems = workflowId === "r2v" && Array.isArray(referenceAssets) && referenceAssets.length
    ? referenceAssets
    : (media || []);
  let ws = null;
  try {
    reportProgress(progressJobId, { value: 1, max: 100, label: "正在准备输入", node: "准备输入", nodeId: "", nodeStep: 0, nodeTotal: 0, detailStep: 0, detailStepMax: 0 });
    for (let index = 0; index < inputItems.length; index += 1) {
      const item = inputItems[index];
      const sourceValue = item && typeof item === "object" ? (item.filePath || item.path || item.sourcePath) : item;
      if (!String(sourceValue || "").trim()) continue;
      if (task.canceled) throw new Error("任务已取消");
      const source = path.resolve(String(sourceValue));
      if (!fs.existsSync(source)) throw new Error(`找不到输入文件：${path.basename(source)}`);
      if (workflowId === "r2v" && !imageFilePattern.test(source)) throw new Error(`参考生视频仅支持图片：${path.basename(source)}`);
      const videoInput = ["continuation", "control"].includes(workflowId);
      const filename = videoInput ? `app_${crypto.randomUUID().slice(0, 8)}${workflowId === "continuation" ? ".png" : ".mp4"}` : `app_${crypto.randomUUID().slice(0, 8)}_${path.basename(source)}`;
      uploaded.push({ filename, index });
      if (videoInput) await prepareStudioVideo(source, path.join(root, "input", filename), workflowId, settings.duration, task);
      else fs.copyFileSync(source, path.join(root, "input", filename));
    }
  } catch (error) {
    cleanupUploaded();
    throw error;
  }
  reportProgress(progressJobId, { value: 3, max: 100, label: "正在提交工作流", node: "提交工作流", nodeId: "", nodeStep: 0, nodeTotal: 0, detailStep: 0, detailStepMax: 0 });
  if (["i2v", "continuation", "multiframe", "control"].includes(workflowId)) {
    try { bindGenerationInputs(graph, workflowId, uploaded, settings); }
    catch (error) { cleanupUploaded(); throw error; }
  } else {
  const imageNodeEntries = Object.entries(graph).filter(([, node]) => node.class_type === "LoadImage");
  const referenceNodes = Object.values(graph).filter((node) => node.class_type === "MiniMaxH3ReferenceToVideo");
  referenceNodes.forEach((node) => {
    Object.keys(node.inputs).filter((key) => key.startsWith("ref_images.ref_image_")).forEach((key) => delete node.inputs[key]);
  });
  let nextNodeId = Math.max(0, ...Object.keys(graph).map((key) => Number(key)).filter(Number.isFinite)) + 1;
  uploaded.forEach(({ filename, index }) => {
    const existingNodeId = imageNodeEntries[index]?.[0];
    let nodeId = existingNodeId;
    if (existingNodeId) graph[existingNodeId].inputs.image = filename;
    else {
      nodeId = String(nextNodeId++);
      graph[nodeId] = { inputs: { image: filename }, class_type: "LoadImage", _meta: { title: "加载图像" } };
    }
    referenceNodes.forEach((node) => { node.inputs[`ref_images.ref_image_${index}`] = [nodeId, 0]; });
  });
  // Remove template image nodes that are no longer connected after replacing references.
  const referencedNodeIds = new Set();
  Object.values(graph).forEach((node) => Object.values(node.inputs || {}).forEach((value) => {
    if (Array.isArray(value) && typeof value[0] === "string") referencedNodeIds.add(value[0]);
  }));
  Object.entries(graph).forEach(([id, node]) => {
    if (node.class_type === "LoadImage" && !referencedNodeIds.has(id)) delete graph[id];
  });
  }
  Object.values(graph).forEach((node) => {
    if (["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"].includes(node.class_type)) node.inputs.prompt = prompt;
    if (node.class_type === "PrimitiveStringMultiline") node.inputs.value = prompt;
  });
  let promptId = null;
  let historyComplete = false;
  let executionComplete = false;
  let currentNodeId = "";
  const completedNodeIds = new Set();
  const executionNodeIds = [];
  // Utility nodes (input plumbing, prompt constants and file saving) make the
  // raw graph count much larger than the work the user actually waits for.
  // Count only executable nodes so the overall percentage tracks real work.
  const progressNodeIds = new Set(Object.entries(graph)
    .filter(([, node]) => !["LoadImage", "SaveVideo", "PreviewImage", "PrimitiveStringMultiline", "PrimitiveFloat", "RandomNoise"].includes(node?.class_type))
    .map(([nodeId]) => String(nodeId)));
  const totalNodeCount = Math.max(1, progressNodeIds.size);
  const nodeLabel = (nodeId) => {
    const node = graph?.[String(nodeId)] || graph?.[nodeId];
    return node?._meta?.title || node?.class_type || "处理节点";
  };
  const overallProgress = (fraction = 0) => {
    const completed = [...completedNodeIds].filter((nodeId) => progressNodeIds.has(String(nodeId))).length;
    const activeFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
    // Reserve a small preparation baseline so a running job never appears to
    // be stuck at 0%, while still leaving 100% exclusively for completion.
    return Math.min(99, Math.max(3, 3 + ((completed + activeFraction) / totalNodeCount) * 94));
  };
  const progressCompletedNodeCount = () => [...completedNodeIds].filter((nodeId) => progressNodeIds.has(String(nodeId))).length;
  try {
    ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${clientId}`);
      const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket timeout")); }, 2000);
      socket.once("open", () => { clearTimeout(timer); resolve(socket); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    task.ws = ws;
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const data = message.data || {};
        // A WebSocket is opened before /prompt returns its id. Ignore all
        // execution messages until this task has an id, then require an exact
        // match so stale events cannot leak into the current queue item.
        if (!promptId || !data.prompt_id || data.prompt_id !== promptId) return;
        if (message.type === "executing" && data.node !== null && data.node !== undefined) {
          currentNodeId = String(data.display_node || data.node);
          const executionNodeId = String(data.display_node || data.node);
          if (!executionNodeIds.includes(executionNodeId)) executionNodeIds.push(executionNodeId);
          const label = nodeLabel(data.display_node || data.node);
          reportProgress(progressJobId, { value: overallProgress(0), max: 100, label: `正在执行：${label}`, node: label, nodeId: executionNodeId, nodeStep: Math.min(totalNodeCount, progressCompletedNodeCount() + 1), nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 });
        }
        if (message.type === "progress") {
          const step = Number(data.value) || 0;
          const stepMax = Number(data.max) || 100;
          const nodeId = data.node || currentNodeId;
          currentNodeId = String(nodeId || currentNodeId);
          const executionNodeId = String(data.display_node || nodeId || currentNodeId);
          if (!executionNodeIds.includes(executionNodeId)) executionNodeIds.push(executionNodeId);
          const label = nodeLabel(data.node || data.display_node || currentNodeId);
          // The fraction contributes to the total percentage, but the sampling sub-step is kept internal.
          reportProgress(progressJobId, { value: overallProgress(step / Math.max(1, stepMax)), max: 100, label: `正在执行：${label}`, node: label, nodeId: executionNodeId, nodeStep: Math.min(totalNodeCount, progressCompletedNodeCount() + 1), nodeTotal: totalNodeCount, detailStep: step, detailStepMax: stepMax });
        }
        if (message.type === "executed" && data.node !== null && data.node !== undefined) {
          const nodeId = String(data.node);
          completedNodeIds.add(nodeId);
          currentNodeId = String(data.display_node || data.node);
          const label = nodeLabel(data.display_node || data.node);
          reportProgress(progressJobId, { value: overallProgress(0), max: 100, label: `已完成：${label}`, node: label, nodeId: String(data.display_node || data.node), nodeStep: Math.min(totalNodeCount, progressCompletedNodeCount()), nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 });
        }
        if (message.type === "executing" && data.node === null && promptId && (!data.prompt_id || data.prompt_id === promptId)) { executionComplete = true; const update = { value: 100, max: 100, label: "完成", node: "完成", nodeId: "", nodeStep: totalNodeCount, nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 }; reportProgress(progressJobId, update); ws.close(); }
      } catch (_) {}
    });
  } catch (_) {
    ws = null;
  }
  try {
    reportProgress(progressJobId, { value: 3, max: 100, label: "执行中，等待后端节点进度", node: "等待后端节点进度", nodeId: "", nodeStep: 0, nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0, indeterminate: true });
    const result = await requestJson("POST", "/prompt", { prompt: graph, client_id: clientId });
    if (result.error || !result.prompt_id) throw new Error(describeEngineError(result, "引擎未返回任务编号，提交失败"));
    promptId = result.prompt_id;
    task.promptId = promptId;
    if (task.canceled) {
      await cancelPrompt(requestJson, promptId);
      throw new Error("任务已取消");
    }
    for (let i = 0; i < 3600; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (task.canceled) { await cancelPrompt(requestJson, promptId); throw new Error("任务已取消"); }
      const history = await requestJson("GET", `/history/${encodeURIComponent(promptId)}`);
      if (history[promptId]) {
        historyComplete = true;
        if (activeTask === task) activeTask = { promptId: null, ws: null };
        const status = history[promptId].status || {};
        if (status.status_str === "error" || status.status_str === "execution_error") throw new Error(describeEngineError(history[promptId], "ComfyUI 执行失败，请查看 logs/backend.log"));
        const completed = history[promptId];
        const outputDir = path.resolve(root, "output");
        const metadataPath = path.join(root, "user", "studio-history.json");
        const metadata = readStudioHistory();
        const generatedPaths = savedVideoPaths(completed, graph, outputDir, fs.existsSync);
        if (!generatedPaths.length) throw new Error("引擎完成但未返回可用视频，请查看运行日志");
        for (const file of generatedPaths) {
          const relative = path.relative(outputDir, file).replace(/\\/g, "/");
          metadata[relative] = { ...(metadata[relative] || {}), jobId: progressJobId, workflow: workflowId, prompt: originalPrompt || prompt, originalPrompt: originalPrompt || prompt, promptParts: Array.isArray(promptParts) ? promptParts : [], duration: settings.duration || 5, resolution: settings.resolution || "standard", aspectRatio: settings.aspectRatio || "", fps: 24, seed: settings.seed ?? "", samplingMode: settings.samplingMode || "quality", style: settings.style || "", frameTimes: settings.frameTimes || [], controlMode: settings.controlMode || "pose", controlStrength: settings.controlStrength ?? 1, width, height, createdAt: Date.now() };
        }
        fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
        atomicWriteText(metadataPath, JSON.stringify(metadata, null, 2));
        reportProgress(progressJobId, { value: 100, max: 100, label: "完成", node: "完成", nodeId: "", nodeStep: totalNodeCount, nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 });
        return { ...completed, outputPath: generatedPaths[0], outputPaths: generatedPaths };
      }
    }
    throw new Error("任务等待超时");
  } finally {
    if (promptId && !historyComplete) {
      try { await cancelPrompt(requestJson, promptId); }
      catch (error) { emit("status", `清理引擎任务失败：${error.message}`); }
    }
    if (ws) ws.terminate();
    cleanupUploaded();
  }
}

const queueWorkflowNames = { i2v: "图生视频", r2v: "参考生视频", t2v: "文生视频", cutout: "AI抠图", continuation: "视频续接", multiframe: "多帧参考", control: "控制视频" };

async function processQueue() {
  if (queueWorkerPromise || queuePaused || !backendReady || voiceService?.busy || activeAiTool || activeCutoutBatch) return;
  queueWorkerPromise = (async () => {
    while (!queuePaused && backendReady && !voiceService?.busy && !activeAiTool && !activeCutoutBatch) {
      // Re-read the queue for every slot. A batch is enqueued through several
      // IPC calls; keeping one initial snapshot could leave later batch items
      // stuck until the next app restart.
      const jobs = readQueueJobs();
      if (queueLoadError) break;
      const job = jobs.find((item) => item.state === "queued" && item.workflowId !== "cutout");
      if (!job) break;
      job.state = "preparing";
      job.attempts = (job.attempts || 0) + 1;
      job.error = "";
      setJobProgress(job, { value: 0, max: 100, label: "准备中" });
      if (!writeQueueJobs()) {
        job.state = "queued";
        job.startedAt = 0;
        job.attempts = Math.max(0, (job.attempts || 1) - 1);
        job.error = "队列保存失败，已暂停，请检查磁盘空间和写入权限后重试";
        setJobProgress(job, { value: 0, max: 100, label: "等待恢复" });
        activeQueueJobId = "";
        queuePaused = true;
        writeQueuePaused(true);
        emit("status", job.error);
        emitQueue();
        break;
      }
      emitQueue();
      activeQueueJobId = job.id;
      job.state = "running";
      job.startedAt = Date.now();
      setJobProgress(job, { value: 0, max: 100, label: "生成中" });
      if (!writeQueueJobs()) {
        job.state = "queued";
        job.startedAt = 0;
        job.attempts = Math.max(0, (job.attempts || 1) - 1);
        job.error = "队列保存失败，已暂停，请检查磁盘空间和写入权限后重试";
        setJobProgress(job, { value: 0, max: 100, label: "等待恢复" });
        activeQueueJobId = "";
        queuePaused = true;
        writeQueuePaused(true);
        emit("status", job.error);
        emitQueue();
        break;
      }
      emitQueue();
      try {
        activeTask = { promptId: null, ws: null, canceled: false };
        const result = job.workflowId === "cutout"
          ? await cutoutService.run(job, activeTask)
          : await runWorkflow(null, { ...job, jobId: job.id });
        job.state = "completed";
        job.outputPath = result?.outputPath || "";
        job.outputPaths = Array.isArray(result?.outputPaths) ? result.outputPaths : (job.outputPath ? [job.outputPath] : []);
        job.progress = { value: 100, max: 100, label: "已完成" };
        job.completedAt = Date.now();
      } catch (error) {
        job.state = job.cancelRequested ? "cancelled" : "failed";
        job.error = job.cancelRequested ? "已取消" : (error?.message || "生成失败");
        job.progress = { value: 0, max: 100, label: job.state === "cancelled" ? "已取消" : "失败" };
        job.completedAt = Date.now();
      } finally {
        delete job.cancelRequested;
        queueProgressPersistAt.delete(job.id);
        activeQueueJobId = "";
        activeTask = { promptId: null, ws: null };
        if (!writeQueueJobs()) {
          queuePaused = true;
          writeQueuePaused(true);
          emit("status", "任务结果状态保存失败，队列已暂停；请保留当前窗口，检查磁盘空间和写入权限");
        }
        emitQueue();
        if (job.state === "completed") emit("queue-completed", publicQueueJob(job));
        if (job.state === "failed") emit("queue-failed", publicQueueJob(job));
      }
    }
  })().finally(() => { queueWorkerPromise = null; });
  return queueWorkerPromise;
}

async function enqueueWorkflow(payload) {
  if (updateInProgress) throw new Error("正在更新软件，请更新完成后再提交任务");
  if (!backendReady) throw new Error("本地引擎尚未就绪");
  readQueueJobs();
  if (queueLoadError) throw new Error(queueLoadError);
  const workflowId = workflowIdFromValue(payload?.workflow);
  if (workflowId === "cutout") throw new Error("请使用 AI 抠图页面处理图片，视频队列仅接受视频任务");
  const workflowConfig = readWorkflowConfig(workflowId);
  if (!workflowConfig.ok) throw new Error(workflowConfig.error || "读取工作流失败");
  let workflowGraph;
  try { workflowGraph = JSON.parse(workflowConfig.content); } catch (error) { throw new Error(`工作流 JSON 格式不正确：${error.message}`); }
  const validation = validateWorkflowGraph(workflowGraph);
  if (validation) throw new Error(validation);
  const id = crypto.randomUUID();
  const sourceMedia = (Array.isArray(payload?.media) ? payload.media : []).filter((item) => String(item || "").trim());
  const sourceReferenceAssets = (Array.isArray(payload?.referenceAssets) ? payload.referenceAssets : []).map((asset, index) => normalizeReferenceAsset(asset, index));
  validateGenerationInputs(workflowId, workflowId === "r2v" ? sourceReferenceAssets.map(asset => asset.filePath) : sourceMedia, payload?.settings);
  const settings = resolveGenerationSettings(payload?.settings);
  applyGenerationSettings(workflowGraph, workflowId, payload?.settings);
  if (workflowId === "r2v" && sourceReferenceAssets.length > 9) throw new Error("参考生视频最多支持 9 张图片");
  let media = [];
  let referenceAssets = [];
  try {
    media = await stageQueueMedia(id, sourceMedia);
    if (workflowId === "r2v") referenceAssets = await stageReferenceAssets(id, sourceReferenceAssets);
  } catch (error) {
    cleanupQueueMedia({ id });
    throw error;
  }
  const job = {
    id,
    workflowId,
    workflowName: queueWorkflowNames[workflowId],
    workflow: workflowFileName(workflowId),
    workflowGraph,
    prompt: String(payload?.prompt || ""),
    originalPrompt: String(payload?.originalPrompt || payload?.prompt || ""),
    promptParts: Array.isArray(payload?.promptParts) ? payload.promptParts : [],
    references: Array.isArray(payload?.references) ? payload.references : [],
    media,
    sourceMedia: sourceMedia.map((item) => path.resolve(String(item))),
    referenceAssets,
    settings,
    state: "queued",
    progress: { value: 0, max: 100, label: "排队中" },
    createdAt: Date.now(),
    startedAt: 0,
    completedAt: 0,
    attempts: 0,
    batchId: String(payload?.batchId || ""),
    batchIndex: Number(payload?.batchIndex) || 0,
    batchTotal: Number(payload?.batchTotal) || 0,
    error: "",
    outputPath: "",
    outputPaths: [],
  };
  const jobs = readQueueJobs();
  jobs.push(job);
  if (!writeQueueJobs()) {
    jobs.splice(jobs.indexOf(job), 1);
    cleanupQueueMedia(job);
    throw new Error("队列保存失败，本次任务未加入，请检查磁盘空间和写入权限后重试");
  }
  emitQueue();
  const position = readQueueJobs().filter((item) => item.state === "queued").findIndex((item) => item.id === id) + 1;
  processQueue();
  return { ok: true, job: publicQueueJob(job, position), position };
}

// AI cutout uses its own short-lived batch channel. It intentionally never
// writes to studio-queue.json, so image processing cannot appear in the video
// queue or affect video queue controls.
async function runCutoutBatch(payload) {
  if (activeAiTool) throw new Error("AI 工具正在处理，请完成或停止后再抠图");
  if (voiceService?.busy) throw new Error("语音正在生成，请完成或停止后再处理图片");
  if (updateInProgress) throw new Error("正在更新软件，请更新完成后再处理图片");
  if (!backendReady) throw new Error("本地引擎尚未就绪");
  if (activeCutoutBatch) throw new Error("已有抠图任务正在处理");
  const workflowId = workflowIdFromValue(payload?.workflow);
  if (workflowId !== "cutout") throw new Error("无效的抠图工作流");
  const workflowConfig = readWorkflowConfig("cutout");
  if (!workflowConfig.ok) throw new Error(workflowConfig.error || "读取抠图工作流失败");
  let workflowGraph;
  try { workflowGraph = JSON.parse(workflowConfig.content); } catch (error) { throw new Error(`抠图工作流 JSON 格式不正确：${error.message}`); }
  const validation = validateCutoutGraph(workflowGraph);
  if (validation) throw new Error(validation);
  const requestedMedia = (Array.isArray(payload?.media) ? payload.media : [])
    .map((item) => String(item || "").trim()).filter(Boolean);
  const seenMedia = new Set();
  const invalidMedia = [];
  const sourceMedia = [];
  for (const item of requestedMedia) {
    const source = path.resolve(item);
    const key = source.toLowerCase();
    if (seenMedia.has(key)) continue;
    seenMedia.add(key);
    if (!imageAssetPattern.test(source) || !fs.existsSync(source)) { invalidMedia.push(path.basename(source)); continue; }
    try {
      if (fs.statSync(source).size > 50 * 1024 * 1024) { invalidMedia.push(`${path.basename(source)}（超过 50 MB）`); continue; }
    } catch (_) { invalidMedia.push(path.basename(source)); continue; }
    sourceMedia.push(source);
  }
  if (invalidMedia.length) throw new Error(`以下图片无法处理：${invalidMedia.slice(0, 5).join("、")}${invalidMedia.length > 5 ? "等" : ""}`);
  if (!sourceMedia.length) throw new Error("请先添加至少一张图片");
  if (sourceMedia.length > 50) throw new Error("一次最多处理 50 张图片");
  const batch = {
    id: crypto.randomUUID(),
    sourceMedia,
    total: sourceMedia.length,
    completed: 0,
    failed: 0,
    canceledCount: 0,
    canceled: false,
    items: new Map(),
  };
  const cutoutOptions = { ...(payload.cutoutOptions || {}) };
  if (cutoutOptions.batchFolder && !String(cutoutOptions.batchName || "").trim()) {
    cutoutOptions.batchName = `batch-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${batch.id.slice(0, 8)}`;
  }
  activeCutoutBatch = batch;
  emit("cutout-started", { batchId: batch.id, total: batch.total });
  const results = [];
  try {
    for (let index = 0; index < sourceMedia.length; index += 1) {
      if (batch.canceled) break;
      const itemId = `${batch.id}-${index + 1}`;
      batch.items.set(itemId, { index });
      const task = { promptId: null, ws: null, canceled: false };
      batch.task = task;
      emit("cutout-progress", { batchId: batch.id, itemId, index, total: batch.total, value: 0, max: 100, label: "准备图片", indeterminate: true });
      try {
        const result = await cutoutService.run({
          id: itemId,
          batchId: batch.id,
          batchIndex: index + 1,
          batchTotal: batch.total,
          workflowGraph,
          media: [sourceMedia[index]],
          inputName: path.basename(sourceMedia[index]),
          cutoutOptions,
        }, task);
        batch.completed += 1;
        results.push({ index, inputPath: sourceMedia[index], outputPath: result?.outputPath || "" });
        emit("cutout-completed", { batchId: batch.id, itemId, index, total: batch.total, outputPath: result?.outputPath || "" });
      } catch (error) {
        const canceled = Boolean(task.canceled || batch.canceled || /任务已取消/.test(error?.message || ""));
        if (canceled) { batch.canceled = true; batch.canceledCount += 1; }
        else batch.failed += 1;
        results.push({ index, inputPath: sourceMedia[index], error: canceled ? "已取消" : (error?.message || "抠图失败"), canceled });
        emit("cutout-failed", { batchId: batch.id, itemId, index, total: batch.total, error: canceled ? "已取消" : (error?.message || "抠图失败"), canceled });
        if (canceled) break;
      } finally {
        batch.items.delete(itemId);
      }
    }
    const skipped = batch.total - batch.completed - batch.failed;
    emit("status", batch.canceled
      ? `抠图已取消，完成 ${batch.completed}/${batch.total}`
      : `抠图完成 ${batch.completed}/${batch.total}${batch.failed ? `，失败 ${batch.failed} 张` : ""}`);
    return { ok: batch.failed === 0 && !batch.canceled, canceled: batch.canceled, batchId: batch.id, total: batch.total, completed: batch.completed, failed: batch.failed, skipped, results };
  } finally {
    activeCutoutBatch = null;
    processQueue();
  }
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1800, Math.max(1280, Math.round(workArea.width * 0.82)));
  const height = Math.min(1100, Math.max(800, Math.round(workArea.height * 0.82)));
  win = new BrowserWindow({ width, height, minWidth: 1040, minHeight: 700, backgroundColor: "#0b0f15", titleBarStyle: "hiddenInset", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, webviewTag: true } });
  const rendererLogPath = path.join(rootDir(), "logs", "renderer.log");
  rotateLog(rendererLogPath);
  const rendererLog = (message) => {
    try { fs.mkdirSync(path.dirname(rendererLogPath), { recursive: true }); fs.appendFileSync(rendererLogPath, `[${new Date().toISOString()}] ${message}\n`); } catch (_) {}
  };
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => rendererLog(`did-fail-load ${errorCode}: ${errorDescription} ${validatedURL}`));
  win.webContents.on("render-process-gone", (_event, details) => rendererLog(`render-process-gone ${JSON.stringify(details)}`));
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => rendererLog(`console[${level}] ${message} (${sourceId}:${line})`));
  win.webContents.on("dom-ready", () => rendererLog("dom-ready"));
  win.webContents.on("preload-error", (_event, preloadPath, error) => rendererLog(`preload-error ${preloadPath}: ${error.message}`));
  win.webContents.on("did-finish-load", () => {
    win.webContents.executeJavaScript("JSON.stringify({readyState:document.readyState,root:document.getElementById('root')?.innerHTML?.length||0,studio:typeof window.studio})")
      .then((value) => rendererLog(`did-finish-load-state ${value}`))
      .catch((error) => rendererLog(`state-check-error ${error.message}`));
  });
  win.loadFile(path.join(__dirname, "..", "dist", "index.html")).catch((error) => rendererLog(`load-file-error ${error.message}`));
  win.on("closed", () => { if (backend && !backend.killed) backend.kill(); win = null; });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    queuePaused = readQueuePaused();
    try { pruneQueueInputDirs(); } catch (_) {}
    createWindow();
    cutoutService = createCutoutService({ rootDir, requestJson, reportProgress, atomicWriteText, getPort: () => port });
    try { await startStudioApi(); }
    catch (error) { emit("status", `H3 本机接口启动失败：${error.message}`); }
    try {
      await startBackend();
    } catch (error) { emit("status", error.message); }
  });
}
app.on("window-all-closed", () => { app.quit(); });
app.on("before-quit", () => {
  try { preferences.flush(); } catch (error) { console.error("配置保存失败", error); }
  stopStudioApi();
  voiceService?.dispose();
  if (backend && !backend.killed) backend.kill();
  if (backendDbPath) { try { fs.rmSync(backendDbPath, { force: true }); } catch (_) {} backendDbPath = ""; }
  if (backendLogFd !== null) { try { fs.closeSync(backendLogFd); } catch (_) {} backendLogFd = null; }
});

ipcMain.handle("pick-file", async (_event, kind) => {
  const filters = kind === "video" ? [{ name: "视频", extensions: ["mp4", "mov", "mkv", "webm", "avi"] }] : [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "avif"] }];
  const result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters });
  return result.canceled ? "" : result.filePaths[0];
});
ipcMain.handle("pick-files", async (_event, kind) => {
  const filters = kind === "image" ? [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "avif"] }] : kind === "video" ? [{ name: "视频", extensions: ["mp4", "mov", "mkv", "webm", "avi"] }] : [{ name: "文件", extensions: ["*"] }];
  const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle("voice-state", () => getVoiceService().state());
ipcMain.handle("ai-tools-state", () => aiToolState());
ipcMain.handle("run-ai-tool", async (_event, payload) => {
  try { return await runAiTool(payload || {}); }
  catch (error) { return { ok: false, error: error.message || "AI 工具执行失败" }; }
});
ipcMain.handle("cancel-ai-tool", async () => {
  if (!activeAiTool) return { ok: false, error: "当前没有 AI 工具任务" };
  activeAiTool.canceled = true;
  if (activeAiTool.promptId) await cancelPrompt(requestJson, activeAiTool.promptId).catch(() => {});
  return { ok: true };
});
ipcMain.handle("list-voices", () => getVoiceService().list());
ipcMain.handle("generate-voice", async (_event, payload) => {
  try { return await getVoiceService().generate(payload || {}); }
  catch (error) { return { ok: false, error: error.message || "语音生成失败" }; }
});
ipcMain.handle("cancel-voice", () => getVoiceService().cancel());
ipcMain.handle("delete-voice", (_event, candidate) => {
  try { return getVoiceService().remove(candidate); }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("clear-voices", () => {
  try { return getVoiceService().clear(); }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("reveal-voice", (_event, candidate) => {
  const target = getVoiceService().managedPath(candidate);
  if (!target || !fs.existsSync(target)) return { ok: false, error: "音频不存在" };
  shell.showItemInFolder(target);
  return { ok: true };
});
ipcMain.handle("export-voice", async (_event, candidate) => {
  const target = getVoiceService().managedPath(candidate);
  if (!target || !fs.existsSync(target)) return { ok: false, error: "音频不存在" };
  const result = await dialog.showSaveDialog(win, { defaultPath: path.basename(target), filters: [{ name: "WAV 音频", extensions: ["wav"] }] });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try { if (path.resolve(result.filePath) !== path.resolve(target)) fs.copyFileSync(target, result.filePath); return { ok: true, path: result.filePath }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("open-voice-folder", async () => {
  const target = path.join(rootDir(), "output", "tts");
  try { fs.mkdirSync(target, { recursive: true }); const error = await shell.openPath(target); return error ? { ok: false, error } : { ok: true }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("backend-url", () => backendReady && port ? `http://127.0.0.1:${port}` : "");
ipcMain.handle("engine-state", async () => {
  readQueueJobs();
  if (!backendReady || !port) return { ready: false, queueError: queueLoadError };
  try { await requestJson("GET", "/system_stats"); return { ready: true, queueError: queueLoadError }; }
  catch (_) { return { ready: false, queueError: queueLoadError }; }
});
ipcMain.handle("reference-capabilities", async () => {
  const fallback = { min: 0, max: 9 };
  if (!backendReady || !port) return { ok: false, images: fallback, error: "本地引擎尚未就绪" };
  try {
    const info = await requestJson("GET", "/object_info/MiniMaxH3ReferenceToVideo");
    const nodeInfo = info?.MiniMaxH3ReferenceToVideo || {};
    const refInput = nodeInfo?.input?.required?.ref_images || nodeInfo?.input?.optional?.ref_images || {};
    const template = refInput?.template || refInput?.default || {};
    const max = Number(template?.max ?? refInput?.max ?? fallback.max);
    const min = Number(template?.min ?? refInput?.min ?? fallback.min);
    return { ok: true, images: { min: Number.isFinite(min) ? Math.max(0, min) : fallback.min, max: Number.isFinite(max) ? Math.max(1, Math.min(9, max)) : fallback.max } };
  } catch (error) {
    return { ok: false, images: fallback, error: error.message || "读取参考图能力失败" };
  }
});
ipcMain.handle("preflight-workflow", async (_event, payload = {}) => {
  const workflowId = workflowIdFromValue(payload?.workflow);
  const config = readWorkflowConfig(workflowId);
  if (!config.ok) return { ok: false, error: config.error || "读取工作流失败" };
  let graph;
  try { graph = JSON.parse(config.content); } catch (error) { return { ok: false, error: `工作流 JSON 格式不正确：${error.message}` }; }
  const validation = validateWorkflowGraph(graph);
  if (validation) return { ok: false, error: validation };
  const sourceMedia = Array.isArray(payload?.media) ? payload.media.filter((item) => String(item || "").trim()) : [];
  const references = Array.isArray(payload?.referenceAssets) ? payload.referenceAssets : [];
  const inputItems = workflowId === "r2v" ? references : sourceMedia;
  const settings = { ...(payload?.settings || {}), fps: 24 };
  try {
    validateGenerationInputs(workflowId, workflowId === "r2v" ? references.map(item => item.filePath || item.path || item.sourcePath || "") : sourceMedia, settings);
    applyGenerationSettings(graph, workflowId, settings);
    if (["i2v", "continuation", "multiframe", "control"].includes(workflowId)) bindGenerationInputs(graph, workflowId, sourceMedia.map((file, index) => ({ filename: path.basename(file), index })), settings);
    const style = generationStyles.find(item => item.id === settings.style);
    if (style && !fs.existsSync(path.join(modelDirectory(), "embeddings", style.file))) throw new Error(`缺少风格模型：${style.name}`);
  } catch (error) { return { ok: false, error: error.message }; }
  for (let index = 0; index < inputItems.length; index += 1) {
    const item = inputItems[index];
    const filePath = path.resolve(String(item?.filePath || item?.path || item?.sourcePath || item || ""));
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: `找不到第 ${index + 1} 个输入文件` };
    if (workflowId === "r2v" && !imageFilePattern.test(filePath)) return { ok: false, error: `参考生视频仅支持图片：${path.basename(filePath)}` };
  }
  if (workflowId === "r2v" && references.length > 9) return { ok: false, error: "参考生视频最多支持 9 张图片" };
  const runtime = await inspectWorkflowRuntime(graph);
  let system = null;
  if (backendReady && port) {
    try { system = await requestJson("GET", "/system_stats"); } catch (_) {}
  }
  const warnings = [...runtime.warnings, ...buildPreflightWarnings({ workflowId, settings, inputCount: inputItems.length, system })];
  if (runtime.errors.length) return { ok: false, workflowId, custom: config.custom, error: runtime.errors.join("；"), warnings };
  const platformSupported = process.platform === "win32" && process.arch === "x64";
  const device = Array.isArray(system?.devices) ? system.devices[0] : null;
  const gpuName = String(device?.name || device?.type || "");
  const gpuAvailable = Boolean(device && (gpuName || Number(device.vram_total ?? device.torch_vram_total) > 0));
  const gpuSupported = gpuAvailable && /cuda|nvidia/i.test(gpuName || String(device?.type || ""));
  if (!platformSupported) return { ok: false, workflowId, custom: config.custom, error: "当前便携引擎仅支持 Windows x64", warnings };
  if (!gpuSupported) return { ok: false, workflowId, custom: config.custom, error: gpuAvailable ? `当前显卡不支持 NVIDIA CUDA：${gpuName}` : "未检测到可用的 NVIDIA CUDA 显卡", warnings };
  return { ok: true, workflowId, custom: config.custom, warnings };
});
ipcMain.handle("load-workflow-config", (_event, workflowId) => readWorkflowConfig(workflowId));
ipcMain.handle("generation-styles", () => generationStyles);
ipcMain.handle("pick-workflow-json", async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "ComfyUI API 工作流", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  try {
    const filePath = result.filePaths[0];
    const graph = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { ok: true, path: filePath, name: path.basename(filePath), content: JSON.stringify(graph, null, 2) };
  } catch (error) {
    return { ok: false, error: `导入失败：${error.message}` };
  }
});
ipcMain.handle("save-workflow-config", async (_event, workflowId, content) => {
  const id = workflowIdFromValue(workflowId);
  let graph;
  try { graph = typeof content === "string" ? JSON.parse(content) : content; }
  catch (error) { return { ok: false, error: `JSON 格式不正确：${error.message}` }; }
  const validation = validateWorkflowGraph(graph);
  if (validation) return { ok: false, error: validation };
  const target = customWorkflowPath(id);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, workflowBackupPath(id));
      pruneWorkflowBackups(id);
    }
    fs.writeFileSync(target, JSON.stringify(graph, null, 2), "utf8");
    return { ok: true, workflowId: id, custom: true, content: JSON.stringify(graph, null, 2) };
  } catch (error) {
    return { ok: false, error: `保存失败：${error.message}` };
  }
});
ipcMain.handle("reset-workflow-config", async (_event, workflowId) => {
  const id = workflowIdFromValue(workflowId);
  const target = customWorkflowPath(id);
  try {
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, workflowBackupPath(id));
      fs.unlinkSync(target);
    }
    return readWorkflowConfig(id);
  } catch (error) {
    return { ok: false, error: `恢复默认失败：${error.message}` };
  }
});
ipcMain.handle("enqueue-workflow", async (_event, payload) => {
  try { return await enqueueWorkflow(payload || {}); }
  catch (error) { return { ok: false, error: error.message || "加入队列失败" }; }
});
ipcMain.handle("run-cutout-batch", async (_event, payload) => {
  try { return await runCutoutBatch(payload || {}); }
  catch (error) { return { ok: false, error: error.message || "抠图失败" }; }
});
ipcMain.handle("cancel-cutout-batch", async () => {
  if (!activeCutoutBatch?.task) return { ok: false, error: "没有正在处理的抠图任务" };
  const batch = activeCutoutBatch;
  const task = batch.task;
  batch.canceled = true;
  task.canceled = true;
  if (task.preparation) task.preparation.kill();
  if (task.promptId) {
    try { await cancelPrompt(requestJson, task.promptId); }
    catch (error) { return { ok: false, error: `停止失败：${error.message}` }; }
  }
  if (task.ws) task.ws.close();
  return { ok: true };
});
ipcMain.handle("list-queue", () => queueSnapshot());
ipcMain.handle("reorder-queue-item", (_event, jobId, targetIndex) => {
  const jobs = readQueueJobs();
  const queuedIndexes = jobs.map((job, index) => job.state === "queued" ? index : -1).filter((index) => index >= 0);
  const from = queuedIndexes.findIndex((index) => jobs[index].id === String(jobId || ""));
  if (from < 0) return { ok: false, error: "只有排队中的任务可以调整顺序" };
  const to = Math.max(0, Math.min(queuedIndexes.length - 1, Number(targetIndex) || 0));
  if (from === to) return { ok: true };
  const ordered = queuedIndexes.map((index) => jobs[index]);
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  queuedIndexes.forEach((index, position) => { jobs[index] = ordered[position]; });
  writeQueueJobs();
  emitQueue();
  processQueue();
  return { ok: true };
});
ipcMain.handle("queue-paused", () => queuePaused);
ipcMain.handle("queue-retention-days", () => readQueueRetentionDays());
ipcMain.handle("set-queue-retention-days", (_event, value) => writeQueueRetentionDays(value));
ipcMain.handle("pause-queue", () => {
  queuePaused = true;
  const persisted = writeQueuePaused(true);
  emitQueue();
  return { ok: persisted, paused: true, message: "已暂停后续任务；当前正在执行的任务会继续完成", error: persisted ? "" : "暂停状态保存失败" };
});
ipcMain.handle("resume-queue", () => {
  const persisted = writeQueuePaused(false);
  if (!persisted) {
    queuePaused = true;
    emitQueue();
    return { ok: false, paused: true, error: "继续状态保存失败，队列保持暂停，请检查磁盘后重试" };
  }
  queuePaused = false;
  processQueue();
  emitQueue();
  return { ok: persisted, paused: false, message: "已恢复队列", error: persisted ? "" : "继续状态保存失败" };
});
ipcMain.handle("cancel-queue-item", async (_event, jobId) => {
  const job = readQueueJobs().find((item) => item.id === String(jobId || ""));
  if (!job || ["completed", "failed", "cancelled"].includes(job.state)) return { ok: false, error: "任务当前不可取消" };
  if (job.id === activeQueueJobId) {
    const task = activeTask;
    job.cancelRequested = true;
    task.canceled = true;
  if (task.preparation) task.preparation.kill();
    if (task.promptId) {
      try { await cancelPrompt(requestJson, task.promptId); }
      catch (error) { return { ok: false, error: `停止失败：${error.message}` }; }
    }
    if (task.ws) task.ws.close();
  } else {
    job.state = "cancelled";
    job.error = "已取消";
    job.progress = { value: 0, max: 100, label: "已取消" };
    writeQueueJobs();
    emitQueue();
  }
  return { ok: true };
});
ipcMain.handle("remove-queue-item", (_event, jobId) => {
  const jobs = readQueueJobs();
  const index = jobs.findIndex((item) => item.id === String(jobId || ""));
  if (index < 0) return { ok: false, error: "找不到任务" };
  if (jobs[index].id === activeQueueJobId || ["preparing", "running"].includes(jobs[index].state)) return { ok: false, error: "正在生成的任务不能删除" };
  cleanupQueueMedia(jobs[index]);
  jobs.splice(index, 1);
  writeQueueJobs();
  emitQueue();
  return { ok: true };
});
ipcMain.handle("retry-queue-item", async (_event, jobId) => {
  const job = readQueueJobs().find((item) => item.id === String(jobId || ""));
  if (!job || !["failed", "cancelled", "interrupted"].includes(job.state)) return { ok: false, error: "当前任务不能重试" };
  try {
    const available = (...paths) => paths.find(file => {
      try { return Boolean(file) && fs.statSync(file).isFile(); } catch (_) { return false; }
    }) || "";
    if (Array.isArray(job.referenceAssets) && job.referenceAssets.length) {
      const existingReferences = job.referenceAssets.filter((asset) => {
        try { return Boolean(asset?.filePath) && fs.existsSync(asset.filePath); } catch (_) { return false; }
      });
      if (existingReferences.length !== job.referenceAssets.length) {
        const recovered = job.referenceAssets.map((asset, index) => ({
          ...asset,
          assetId: asset.assetId || asset.id || `reference-${index + 1}`,
          filePath: available(asset.filePath, asset.sourcePath),
        }));
        if (recovered.some(asset => !asset.filePath)) throw new Error("部分参考图片已丢失，请复用输入并重新添加图片");
        job.referenceAssets = await stageReferenceAssets(job.id, recovered, `recovery-${crypto.randomUUID()}`);
      }
    }
    const media = Array.isArray(job.media) ? job.media : [];
    const sourceMedia = Array.isArray(job.sourceMedia) ? job.sourceMedia : [];
    const recovered = Array.from({ length: Math.max(media.length, sourceMedia.length) }, (_, index) => available(media[index], sourceMedia[index]));
    if (recovered.some(file => !file)) throw new Error("部分参考素材已丢失，请复用输入并在原槽位重新添加");
    job.media = recovered.every((file, index) => file === media[index]) ? media : await stageQueueMedia(job.id, recovered, `recovery-${crypto.randomUUID()}`);
  }
  catch (error) { return { ok: false, error: error.message }; }
  job.state = "queued";
  job.error = "";
  job.outputPath = "";
  job.outputPaths = [];
  job.startedAt = 0;
  job.completedAt = 0;
  job.progress = { value: 0, max: 100, label: "排队中" };
  writeQueueJobs();
  emitQueue();
  processQueue();
  return { ok: true };
});
ipcMain.handle("clear-queue", (_event, mode = "finished") => {
  const removable = mode === "all" ? new Set(["completed", "failed", "cancelled", "interrupted"]) : new Set(["completed"]);
  const jobs = readQueueJobs();
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    if (removable.has(jobs[index].state) && jobs[index].id !== activeQueueJobId) { cleanupQueueMedia(jobs[index]); jobs.splice(index, 1); }
  }
  writeQueueJobs();
  emitQueue();
  return { ok: true };
});
ipcMain.handle("run-workflow", async (_event, payload) => {
  try { return await enqueueWorkflow(payload || {}); }
  catch (error) { return { ok: false, error: error.message || "加入队列失败" }; }
});
ipcMain.handle("cancel-workflow", async () => {
  if (!activeTask) return false;
  if (activeQueueJobId) {
    const job = readQueueJobs().find((item) => item.id === activeQueueJobId);
    if (job) job.cancelRequested = true;
  }
  const task = activeTask;
  task.canceled = true;
  if (task.preparation) task.preparation.kill();
  if (task.promptId) {
    try { await cancelPrompt(requestJson, task.promptId); }
    catch (error) { emit("status", `停止失败：${error.message}`); return false; }
  }
  if (task.ws) task.ws.close();
  activeTask = { promptId: null, ws: null };
  emit("progress", { value: 0, max: 100, label: "已取消", ...(activeQueueJobId ? { jobId: activeQueueJobId } : {}) });
  emit("status", "任务已取消");
  return true;
});
ipcMain.handle("open-output", () => shell.openPath(path.join(rootDir(), "output")));
ipcMain.handle("set-audio-muted", (_event, muted) => {
  const value = Boolean(muted);
  if (win && !win.isDestroyed()) win.webContents.setAudioMuted(value);
  return { ok: true, muted: value };
});
ipcMain.handle("list-videos", () => {
  return listVideoFiles(Infinity);
});
ipcMain.handle("list-cutouts", () => {
  return cutoutService?.list?.() || [];
});
ipcMain.handle("export-cutout-batch", async (_event, ids) => {
  if (!cutoutService) return { ok: false, error: "抠图服务尚未就绪" };
  const requested = Array.isArray(ids) ? ids.map((id) => String(id || "")).filter(Boolean) : [];
  if (!requested.length) return { ok: false, error: "没有可导出的抠图结果" };
  const files = [];
  for (const id of requested) {
    try {
      const item = cutoutService.get(id);
      if (item?.path && fs.existsSync(item.path)) files.push({ path: item.path, name: path.basename(item.path) });
    } catch (_) {}
  }
  if (!files.length) return { ok: false, error: "抠图结果文件不存在，无法导出" };
  const result = await dialog.showSaveDialog(win, {
    defaultPath: `AI抠图-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  if (process.platform !== "win32") return { ok: false, error: "当前便携版仅支持 Windows 导出 ZIP" };
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = `$files=@(${files.map((item) => quote(item.path)).join(",")}); Compress-Archive -LiteralPath $files -DestinationPath ${quote(result.filePath)} -Force`;
  return await new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => resolve({ ok: false, error: `导出失败：${error.message}` }));
    child.once("close", (code) => {
      if (code === 0 && fs.existsSync(result.filePath)) resolve({ ok: true, path: result.filePath, count: files.length });
      else resolve({ ok: false, error: stderr.trim() || "导出 ZIP 失败" });
    });
  });
});
ipcMain.handle("clear-cutouts", async (_event) => {
  if (!cutoutService) return { ok: false, error: "抠图服务尚未就绪" };
  if (activeCutoutBatch) return { ok: false, error: "抠图处理中，请完成后再清空" };
  try {
    const existing = cutoutService.list?.() || [];
    if (!existing.length) return { ok: true, canceled: false, entries: 0 };
    const result = _event?.integration ? { response: 1 } : await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["取消", "清空"],
      defaultId: 0,
      cancelId: 0,
      title: "清空抠图记录",
      message: `确定清空最近抠图中的 ${existing.length} 条记录吗？`,
      detail: "抠图结果图片和对应的源图副本也会被删除，此操作无法撤销。",
    });
    if (result.response !== 1) return { ok: false, canceled: true };
    return cutoutService.clear();
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("delete-cutout", async (_event, id) => {
  if (!cutoutService) return { ok: false, error: "抠图服务尚未就绪" };
  try {
    const item = cutoutService.list().find(entry => entry.id === String(id || ""));
    if (!item) throw new Error("找不到抠图记录");
    const result = _event?.integration ? { response: 1 } : await dialog.showMessageBox(win, { type: "warning", buttons: ["取消", "删除"], defaultId: 0, cancelId: 0, title: "删除抠图结果", message: `确定删除“${item.originalName || item.filename}”的结果和源图副本吗？` });
    if (result.response !== 1) return { ok: false, canceled: true };
    return cutoutService.remove(String(id || ""));
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("set-video-favorite", (_event, filePath, favorite) => {
  const target = outputFilePath(filePath);
  if (!target || !fs.existsSync(target)) return { ok: false, error: "无效的输出文件" };
  const outputDir = path.resolve(rootDir(), "output");
  const key = path.relative(outputDir, target).replace(/\\/g, "/");
  try {
    const metadata = readStudioHistory();
    metadata[key] = { ...(metadata[key] || {}), favorite: Boolean(favorite) };
    writeStudioHistory(metadata);
    return { ok: true, favorite: Boolean(favorite) };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("app-version", () => app.getVersion());
ipcMain.handle("integration-info", () => ({ ok: true, appRoot: rootDir(), descriptorPath: studioApiDescriptorPath(), baseUrl: studioApiServer ? `http://127.0.0.1:${studioApiPort}` : "" }));
ipcMain.handle("copy-text", (_event, text) => {
  if (typeof text !== "string" || text.length > 100000) return { ok: false, error: "复制内容无效或过长" };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (error) { return { ok: false, error: `复制失败：${error.message}` }; }
});
ipcMain.handle("check-update", async () => {
  try { return { ok: true, ...(await getUpdateInfo()) }; }
  catch (error) {
    if (error.statusCode === 404) return { ok: false, error: "暂未找到可用的公开发行版本，无法确认是否为最新版" };
    return { ok: false, error: error.message };
  }
});
ipcMain.handle("update-app", async () => {
  if (updateInProgress) return { ok: false, error: "更新正在进行中" };
  let tempPath = "";
  try {
    if (activeQueueJobId || activeCutoutBatch || activeAiTool || voiceService?.busy || readQueueJobs().some((job) => job.state === "queued")) throw new Error("请先完成或取消生成任务，再更新软件");
    updateInProgress = true;
    const info = await getUpdateInfo();
    if (!info.hasUpdate) throw new Error("当前已是最新版本");
    const release = await latestRelease();
    const asset = (release.assets || []).find((item) => isUpdateAsset(item.name));
    if (!asset?.browser_download_url) throw new Error("Release 中没有找到 exe 更新包");
    const targetPath = process.env.PORTABLE_EXECUTABLE_FILE || path.join(rootDir(), "MiniMax H3 Studio.exe");
    if (!fs.existsSync(targetPath)) throw new Error("找不到当前软件入口，请从 App 文件夹启动后更新");
    const updateDir = path.join(path.dirname(targetPath), ".updates");
    fs.mkdirSync(updateDir, { recursive: true });
    tempPath = path.join(updateDir, "MiniMax H3 Studio.exe.download");
    await downloadFile(asset.browser_download_url, tempPath);
    verifyUpdateAsset(tempPath, asset);
    const scriptPath = path.join(updateDir, "apply-update.ps1");
    fs.copyFileSync(path.join(__dirname, "update-runner.ps1"), scriptPath);
    const checksum = crypto.createHash("sha256").update(fs.readFileSync(tempPath)).digest("hex");
    const helper = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Target", targetPath, "-Download", tempPath, "-ExpectedHash", checksum, "-WaitPid", String(process.pid)], { detached: true, windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { helper.once("spawn", resolve); helper.once("error", reject); });
    helper.unref();
    setTimeout(() => app.quit(), 150);
    return { ok: true, updating: true, version: info.latestVersion };
  } catch (error) {
    updateInProgress = false;
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
    return { ok: false, error: error.message };
  }
});
ipcMain.handle("delete-video", async (_event, filePath) => {
  const target = outputFilePath(filePath);
  if (!target || !fs.existsSync(target)) return { ok: false, error: "无效的输出文件" };
  const result = _event?.integration ? { response: 1 } : await dialog.showMessageBox(win, { type: "warning", buttons: ["取消", "删除"], defaultId: 0, cancelId: 0, title: "删除视频", message: `确定删除“${path.basename(target)}”吗？` });
  if (result.response !== 1) return { ok: false, canceled: true };
  try {
    const metadata = readStudioHistory();
    fs.unlinkSync(target);
    const outputDir = path.resolve(rootDir(), "output");
    delete metadata[path.relative(outputDir, target).replace(/\\/g, "/")];
    try { writeStudioHistory(metadata); }
    catch (error) { return { ok: false, deleted: true, error: `视频已删除，但历史记录保存失败：${error.message}` }; }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle("clear-videos", async (_event, workflowId = "", mode = "delete") => {
  let items;
  try { items = listVideoFiles(Infinity).filter((item) => !workflowId || item.workflow === workflowId); }
  catch (error) { return { ok: false, error: error.message }; }
  if (!items.length) return { ok: true, count: 0 };
  const recordsOnly = mode === "records";
  const result = _event?.integration ? { response: 1 } : await dialog.showMessageBox(win, { type: "warning", buttons: ["取消", recordsOnly ? "清除记录" : "删除文件"], defaultId: 0, cancelId: 0, title: recordsOnly ? "清除历史记录" : "删除最近生成", message: recordsOnly ? `将清除 ${items.length} 条历史记录，视频文件会保留在 output 文件夹。确定继续吗？` : `将永久删除 ${items.length} 个视频文件及其记录，且无法撤销。确定继续吗？` });
  if (result.response !== 1) return { ok: false, canceled: true };
  let metadata;
  try { metadata = readStudioHistory(); }
  catch (error) { return { ok: false, error: error.message }; }
  const removed = [];
  const failures = [];
  for (const item of items) {
    if (recordsOnly) { removed.push(item); continue; }
    const target = outputFilePath(item.path);
    if (!target) { failures.push(`${item.name || path.basename(item.path)}：无效的输出文件`); continue; }
    try { fs.unlinkSync(target); removed.push(item); }
    catch (error) {
      if (error.code === "ENOENT") removed.push(item);
      else failures.push(`${path.basename(target)}：${error.message}`);
    }
  }
  try {
    for (const item of removed) delete metadata[path.relative(path.resolve(rootDir(), "output"), item.path).replace(/\\/g, "/")];
    if (removed.length) writeStudioHistory(metadata);
  } catch (error) {
    return { ok: false, count: removed.length, failed: failures.length, error: `已处理 ${removed.length} 个视频，但历史记录保存失败：${error.message}` };
  }
  return { ok: failures.length === 0, count: removed.length, failed: failures.length,
    ...(failures.length ? { error: `已删除 ${removed.length} 个视频，${failures.length} 个未删除：${failures.slice(0, 3).join("；")}` } : {}) };
});
ipcMain.handle("open-video", (_event, filePath) => {
  const target = outputFilePath(filePath);
  return target ? shell.openPath(target) : Promise.resolve("无效的输出文件");
});
ipcMain.handle("file-url", (_event, filePath) => {
  if (!filePath) return "";
  const target = path.resolve(relocatePath(String(filePath), rootDir()));
  return fs.existsSync(target) ? `${pathToFileURL(target).href}?v=${fs.statSync(target).mtimeMs}` : "";
});

ipcMain.handle("load-preferences", (_event, legacy) => {
  try { return { ok: true, values: preferences.load(legacy) }; }
  catch (error) { return { ok: false, error: `读取便携配置失败：${error.message}` }; }
});
ipcMain.handle("save-preference", (_event, key, value) => {
  try { return preferences.save(key, value); }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("prune-assets", (_event, removedPaths) => {
  try { return pruneUnusedAssets(Array.isArray(removedPaths) ? removedPaths : []); }
  catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle("stage-asset", (_event, filePath) => {
  try { return stageAssetFile(filePath); }
  catch (error) { return { ok: false, error: error.message || "素材保存失败" }; }
});

// Clipboard and directory-entry drops can produce an in-memory File without a
// filesystem path. Persist only supported image bytes inside the app's user
// area so the renderer can feed them through the same import pipeline.
ipcMain.handle("save-clipboard-image", (_event, payload = {}) => {
  try {
    const mimeType = String(payload?.mimeType || "").toLowerCase();
    const name = String(payload?.name || "").trim();
    const extensionFromName = path.extname(name).replace(/^\./, "").toLowerCase();
    const extension = ["png", "jpg", "jpeg", "webp", "avif"].includes(extensionFromName)
      ? extensionFromName
      : ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" }[mimeType] || "png");
    const supportedMime = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);
    if (!imageAssetPattern.test(`.${extension}`) || (mimeType && !supportedMime.has(mimeType))) return { ok: false, error: "仅支持 PNG / JPG / WEBP / AVIF 图片" };
    const raw = payload?.buffer;
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw instanceof ArrayBuffer ? raw : (raw?.buffer || raw || []));
    if (!bytes.length) return { ok: false, error: "剪贴板中没有可用图片" };
    if (bytes.length > 50 * 1024 * 1024) return { ok: false, error: "图片不能超过 50 MB" };
    const targetDir = assetLibraryDir();
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `clipboard-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`);
    fs.writeFileSync(target, bytes);
    return { ok: true, path: target, fileUrl: pathToFileURL(target).href, name: name || path.basename(target) };
  } catch (error) { return { ok: false, error: error.message || "图片保存失败" }; }
});

ipcMain.handle("reveal-video", (_event, filePath) => {
  const target = outputFilePath(filePath);
  if (!target || !fs.existsSync(target)) return { ok: false, error: "无效的输出文件" };
  shell.showItemInFolder(target);
  return { ok: true };
});

ipcMain.handle("copy-path", (_event, filePath) => {
  const target = outputFilePath(filePath) || path.resolve(String(filePath || ""));
  if (!target || !fs.existsSync(target)) return { ok: false, error: "文件不存在" };
  clipboard.writeText(target);
  return { ok: true, path: target };
});

ipcMain.handle("rename-video", async (_event, filePath, nextName) => {
  const target = outputFilePath(filePath);
  if (!target || !fs.existsSync(target)) return { ok: false, error: "无效的输出文件" };
  const extension = path.extname(target);
  const base = safeFileName(nextName, path.basename(target, extension));
  const stem = base.toLowerCase().endsWith(extension.toLowerCase()) ? base.slice(0, -extension.length) : base;
  const destination = path.join(path.dirname(target), `${stem}${extension}`);
  if (!isWithin(path.resolve(rootDir(), "output"), destination)) return { ok: false, error: "目标路径不合法" };
  if (destination === target) return { ok: true, path: target };
  if (destination !== target && fs.existsSync(destination)) return { ok: false, error: "同名视频已存在" };
  try {
    const metadata = readStudioHistory();
    if (destination !== target) fs.renameSync(target, destination);
    const outputDir = path.resolve(rootDir(), "output");
    const oldKey = path.relative(outputDir, target).replace(/\\/g, "/");
    const newKey = path.relative(outputDir, destination).replace(/\\/g, "/");
    if (metadata[oldKey]) {
      metadata[newKey] = metadata[oldKey];
      delete metadata[oldKey];
      try { writeStudioHistory(metadata); }
      catch (error) {
        fs.renameSync(destination, target);
        throw error;
      }
    }
    const changedJobs = [];
    for (const job of readQueueJobs()) {
      if (job.outputPath === target || job.outputPaths?.includes(target)) {
        if (job.outputPath === target) job.outputPath = destination;
        if (Array.isArray(job.outputPaths)) job.outputPaths = job.outputPaths.map(file => file === target ? destination : file);
        changedJobs.push(job);
      }
    }
    if (changedJobs.length) { writeQueueJobs(); emitQueue(); }
    return { ok: true, path: destination };
  } catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle("export-video", async (_event, filePath) => {
  const target = outputFilePath(filePath);
  if (!target || !fs.existsSync(target)) return { ok: false, error: "无效的输出文件" };
  const result = await dialog.showSaveDialog(win, { defaultPath: path.basename(target), filters: [{ name: "视频", extensions: [path.extname(target).slice(1) || "mp4"] }] });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try { fs.copyFileSync(target, result.filePath); return { ok: true, path: result.filePath }; }
  catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle("open-directory", (_event, kind) => {
  const root = rootDir();
  const dirs = {
    output: path.join(root, "output"),
    input: path.join(root, "input"),
    "queue-input": path.join(root, "user", "queue-input"),
    logs: path.join(root, "logs"),
    models: modelDirectory(),
    user: path.join(root, "user"),
  };
  const directory = dirs[String(kind || "")] || root;
  try { fs.mkdirSync(directory, { recursive: true }); } catch (_) {}
  return shell.openPath(directory);
});

ipcMain.handle("engine-health", async () => {
  const root = rootDir();
  const platformSupported = process.platform === "win32" && process.arch === "x64";
  const pythonPath = path.join(root, "python", "python.exe");
  const comfyPath = path.join(root, "ComfyUI", "main.py");
  const checks = {
    python: fs.existsSync(pythonPath),
    comfyui: fs.existsSync(comfyPath),
    workflows: fs.existsSync(path.join(root, "workflows")),
    output: fs.existsSync(path.join(root, "output")),
  };
  const pythonResult = checks.python ? await verifyPythonExecutable(pythonPath, root) : { ok: false, error: `找不到 Python：${pythonPath}` };
  checks.python = pythonResult.ok;
  const diagnostics = [];
  const dependencies = [];
  if (pythonResult.ok) {
    const requirementsPath = path.join(root, "ComfyUI", "requirements.txt");
    const requirements = fs.existsSync(requirementsPath) ? fs.readFileSync(requirementsPath, "utf8") : "";
    if (!requirements) diagnostics.push("缺少引擎依赖清单 requirements.txt");
    for (const name of ["comfyui-frontend-package", "comfy-kitchen", "comfy-aimdo"]) {
      const required = requirements.split(/\r?\n/).find((line) => line.startsWith(`${name}==`))?.split("==")[1]?.trim();
      const installed = pythonResult.packages?.[name];
      dependencies.push({ name, required, installed });
      if (!installed || (required && installed !== required)) diagnostics.push(`${name}：当前 ${installed || "未安装"}，需要 ${required || "安装"}`);
    }
    if (!pythonResult.packages?.torch) diagnostics.push("缺少 PyTorch");
  }
  checks.dependencies = pythonResult.ok && diagnostics.length === 0;
  const modelFolders = { unet_name: "diffusion_models", clip_name: "text_encoders", vae_name: "vae", lora_name: "loras", ckpt_name: "checkpoints", name: "model_patches" };
  checks.models = true;
  checks.workflows = true;
  for (const id of ["i2v", "r2v", "t2v", "cutout", "continuation", "multiframe", "control"]) {
    const config = readWorkflowConfig(id);
    if (!config.ok) { checks.workflows = false; diagnostics.push(config.error); continue; }
    try {
      const graph = JSON.parse(config.content);
      for (const node of Object.values(graph)) for (const [input, folder] of Object.entries(modelFolders)) {
        const name = node.inputs?.[input];
        if (typeof name === "string" && name && !fs.existsSync(path.join(modelDirectory(), folder, name))) {
          checks.models = false;
          diagnostics.push(`缺少模型：${name}`);
        }
      }
    } catch (_) { checks.workflows = false; diagnostics.push(`${id} 工作流 JSON 无效`); }
  }
  if (!fs.existsSync(path.join(root, "user", ".transparent-background", "ckpt_base.pth"))) {
    checks.models = false;
    diagnostics.push("缺少抠图模型 ckpt_base.pth");
  }
  let system = null;
  let node = null;
  let error = "";
  if (backendReady && port) {
    try { system = await requestJson("GET", "/system_stats"); } catch (cause) { error = cause.message || "system_stats 读取失败"; }
    try { node = await requestJson("GET", "/object_info/MiniMaxH3ReferenceToVideo"); } catch (_) {}
  } else error = "本地引擎尚未就绪";
  const device = Array.isArray(system?.devices) ? system.devices[0] : null;
  const gpuName = String(device?.name || device?.type || "");
  const gpuAvailable = Boolean(device && (gpuName || Number(device.vram_total || device.torch_vram_total) > 0));
  const gpuSupported = gpuAvailable && /cuda|nvidia/i.test(gpuName || String(device?.type || ""));
  const runtimeIssue = !checks.comfyui ? `找不到 ComfyUI：${comfyPath}` : (!pythonResult.ok ? pythonResult.error : "");
  const runtimeError = !platformSupported ? "当前便携引擎仅支持 Windows x64 + NVIDIA CUDA" : (runtimeIssue || error || [...new Set(diagnostics)].join("；"));
  return {
    ok: !runtimeError && platformSupported && gpuSupported && pythonResult.ok && Object.values(checks).every(Boolean),
    checkedAt: Date.now(),
    checks,
    runtimeRoot: root,
    runtimePaths: { python: pythonPath, comfyui: comfyPath },
    pythonVersion: pythonResult.version || "",
    dependencies,
    backendReady: Boolean(backendReady && system),
    port: port || 0,
    system,
    platform: { name: process.platform, arch: process.arch, supported: platformSupported },
    gpu: { available: gpuAvailable, supported: gpuSupported, name: gpuName || "未检测到 NVIDIA GPU", vramFree: Number(device?.vram_free ?? device?.torch_vram_free ?? 0), vramTotal: Number(device?.vram_total ?? device?.torch_vram_total ?? 0) },
    referenceNode: Boolean(node?.MiniMaxH3ReferenceToVideo),
    logPath: path.join(root, "logs", "backend.log"),
    error: runtimeError,
  };
});

ipcMain.handle("storage-usage", () => {
  const root = rootDir();
  const entries = [
    ["生成视频", path.join(root, "output")],
    ["队列输入", path.join(root, "user", "queue-input")],
    ["运行日志", path.join(root, "logs")],
    ["模型文件", modelDirectory()],
    ["用户配置", path.join(root, "user")],
  ];
  return { ok: true, items: entries.map(([name, directory]) => ({ name, directory, bytes: directorySize(directory), exists: fs.existsSync(directory) })), checkedAt: Date.now() };
});

ipcMain.handle("list-workflow-backups", (_event, workflowId) => {
  const id = workflowIdFromValue(workflowId);
  const backupDir = path.join(rootDir(), "user", "workflows", "backups");
  try {
    const prefix = `${id}.`;
    return fs.readdirSync(backupDir).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort().reverse().map((name) => {
      const filePath = path.join(backupDir, name);
      return { id: name, name, path: filePath, modified: fs.statSync(filePath).mtimeMs };
    });
  } catch (_) { return []; }
});

ipcMain.handle("restore-workflow-backup", (_event, workflowId, backupId) => {
  const id = workflowIdFromValue(workflowId);
  const backupDir = path.resolve(rootDir(), "user", "workflows", "backups");
  const targetBackup = path.resolve(backupDir, path.basename(String(backupId || "")));
  if (!isWithin(backupDir, targetBackup) || !fs.existsSync(targetBackup)) return { ok: false, error: "找不到备份" };
  try {
    const graph = JSON.parse(fs.readFileSync(targetBackup, "utf8"));
    const validation = validateWorkflowGraph(graph);
    if (validation) return { ok: false, error: validation };
    const target = customWorkflowPath(id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.copyFileSync(target, workflowBackupPath(id));
    fs.writeFileSync(target, JSON.stringify(graph, null, 2), "utf8");
    return { ok: true, content: JSON.stringify(graph, null, 2) };
  } catch (error) { return { ok: false, error: `恢复失败：${error.message}` }; }
});

ipcMain.handle("export-config", async (_event, payload) => {
  const result = await dialog.showSaveDialog(win, { defaultPath: `MiniMax-H3-Studio-配置-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON 配置", extensions: ["json"] }] });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try { atomicWriteText(result.filePath, JSON.stringify({ ...(payload || {}), runtimeRoot: rootDir() }, null, 2)); return { ok: true, path: result.filePath }; }
  catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle("import-config", async () => {
  const result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "JSON 配置", extensions: ["json"] }] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  try { const payload = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8")); return { ok: true, path: result.filePaths[0], payload: relocateStoredPaths(payload, rootDir(), payload?.runtimeRoot) }; }
  catch (error) { return { ok: false, error: `导入失败：${error.message}` }; }
});

ipcMain.handle("notify", (_event, title, body) => {
  try {
    if (Notification?.isSupported?.()) new Notification({ title: String(title || "MiniMax H3 Studio"), body: String(body || "") }).show();
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
