const { app, BrowserWindow, dialog, ipcMain, shell, Menu, screen } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const https = require("https");
const WebSocket = require("ws");
const { pathToFileURL } = require("url");

let win;
let backend;
let port;
let backendReady = false;
let clientId = crypto.randomUUID();
let activeTask = { promptId: null, ws: null };
let activeQueueJobId = "";
let queueJobs = null;
let queueWorkerPromise = null;
let queuePaused = false;
let backendLogFd = null;
const UPDATE_REPO = "miaomiao12139/MMH3";
const hasSingleInstanceLock = app.requestSingleInstanceLock();

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

function rootDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (!app.isPackaged) return path.resolve(__dirname, "..", "..", "..", "App");
  return path.dirname(process.execPath);
}

function queueStatePath() {
  return path.join(rootDir(), "user", "studio-queue.json");
}

function queueControlPath() {
  return path.join(rootDir(), "user", "studio-queue-settings.json");
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
    atomicWriteText(queueControlPath(), JSON.stringify({ paused: Boolean(value) }, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function atomicWriteText(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  try {
    const descriptor = fs.openSync(temporaryPath, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
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

function readQueueJobs() {
  if (queueJobs) return queueJobs;
  try {
    const parsed = JSON.parse(fs.readFileSync(queueStatePath(), "utf8"));
    queueJobs = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    queueJobs = [];
  }
  queueJobs = queueJobs.map((job) => job && typeof job === "object" ? job : null).filter(Boolean).map((job) => {
    if (job.state === "running" || job.state === "preparing") return { ...job, state: "interrupted", error: "应用上次未正常结束，请重试" };
    return job;
  });
  return queueJobs;
}

function writeQueueJobs() {
  try {
    const filePath = queueStatePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteText(filePath, JSON.stringify(readQueueJobs(), null, 2));
    return true;
  } catch (error) {
    emit("status", `队列保存失败：${error.message}`);
    return false;
  }
}

function publicQueueJob(job, position = 0) {
  const media = Array.isArray(job.media) ? job.media : [];
  const sourceMedia = Array.isArray(job.sourceMedia) ? job.sourceMedia : [];
  const mediaPaths = media.filter((file) => {
    try { return Boolean(file) && fs.existsSync(file); } catch (_) { return false; }
  });
  const fallbackMediaPaths = media.length > 0 && mediaPaths.length === media.length ? mediaPaths : sourceMedia.filter((file) => {
    try { return Boolean(file) && fs.existsSync(file); } catch (_) { return false; }
  });
  return {
    id: job.id,
    workflowId: job.workflowId,
    workflowName: job.workflowName,
    prompt: job.prompt || "",
    mediaCount: media.length || sourceMedia.length,
    mediaPreviews: fallbackMediaPaths.map((file) => pathToFileURL(file).href),
    settings: job.settings || {},
    state: job.state,
    progress: job.progress || { value: 0, max: 100, label: "排队中" },
    error: job.error || "",
    outputPath: job.outputPath || "",
    createdAt: job.createdAt,
    startedAt: job.startedAt || 0,
    completedAt: job.completedAt || 0,
    attempts: job.attempts || 0,
    position,
  };
}

function queueSnapshot() {
  const jobs = readQueueJobs();
  return jobs.map((job, index) => publicQueueJob(job, index + 1));
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
  job.progress = {
    value: Number(progress.value) || 0,
    max: Number(progress.max) || 100,
    label: progress.label || "生成中",
    node: progress.node || "",
    ...(Number.isFinite(nodeStep) ? { nodeStep } : {}),
    ...(Number.isFinite(nodeTotal) ? { nodeTotal } : {}),
    ...(Number.isFinite(detailStep) ? { detailStep } : {}),
    ...(Number.isFinite(detailStepMax) ? { detailStepMax } : {}),
  };
  writeQueueJobs();
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
  }
  emit("progress", { ...progress, ...(jobId ? { jobId } : {}) });
}

async function stageQueueMedia(jobId, media) {
  const targetDir = queueInputDir(jobId);
  fs.mkdirSync(targetDir, { recursive: true });
  const staged = [];
  try {
    for (const item of media || []) {
      const source = path.resolve(String(item || ""));
      if (!source || !fs.existsSync(source)) throw new Error(`找不到输入文件：${path.basename(source)}`);
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

function cleanupQueueMedia(job) {
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

function emit(channel, value) { if (win && !win.isDestroyed()) win.webContents.send(channel, value); }

function githubRequest(route) {
  return new Promise((resolve, reject) => {
    const request = https.get(`https://api.github.com${route}`, { headers: { "User-Agent": "MiniMax-H3-Studio", Accept: "application/vnd.github+json" } }, (response) => {
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
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`本地引擎返回 ${res.statusCode}`));
        try { resolve(JSON.parse(chunks || "{}")); } catch (error) { reject(new Error(`本地引擎响应格式错误：${error.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("本地引擎请求超时")));
    if (data) req.write(data);
    req.end();
  });
}

async function startBackend() {
  if (process.platform !== "win32") throw new Error("当前便携引擎仅支持 Windows x64 + NVIDIA CUDA");
  const root = rootDir();
  const python = path.join(root, "python", "python.exe");
  const main = path.join(root, "ComfyUI", "main.py");
  if (!fs.existsSync(python) || !fs.existsSync(main)) throw new Error("便携包不完整，找不到 ComfyUI 或 Python");
  port = await freePort();
  backendReady = false;
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.mkdirSync(path.join(root, "user"), { recursive: true });
  fs.mkdirSync(path.join(root, "input"), { recursive: true });
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  backendLogFd = openLog(path.join(root, "logs", "backend.log"));
  const dbUrl = `sqlite:///${path.join(root, "user", "comfyui.db").replace(/\\/g, "/")}`;
  backend = spawn(python, [main, "--windows-standalone-build", "--disable-auto-launch", "--listen", "127.0.0.1", "--port", String(port), "--input-directory", path.join(root, "input"), "--output-directory", path.join(root, "output"), "--user-directory", path.join(root, "user"), "--database-url", dbUrl, "--extra-model-paths-config", path.join(root, "extra_model_paths.yaml")], { cwd: root, windowsHide: true, stdio: ["ignore", backendLogFd, backendLogFd] });
  backend.on("error", (error) => {
    backendReady = false;
    emit("status", `本地引擎启动失败：${error.message}`);
  });
  backend.on("exit", (code) => {
    backendReady = false;
    if (backendLogFd !== null) { try { fs.closeSync(backendLogFd); } catch (_) {} backendLogFd = null; }
    if (code && win) emit("status", `本地引擎已停止（代码 ${code}），详情见 logs/backend.log`);
  });
  for (let i = 0; i < 120; i++) {
    try { await requestJson("GET", "/system_stats"); backendReady = true; emit("status", "本地引擎已就绪"); emitQueue(); processQueue(); return; } catch (_) { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (backend && !backend.killed) backend.kill();
  throw new Error("本地引擎启动超时，请查看 logs/backend.log");
}

function loadWorkflow(name) {
  const workflowId = name.includes("参考") ? "r2v" : name.includes("图生") ? "i2v" : "t2v";
  const custom = path.join(rootDir(), "user", "workflows", `${workflowId}.custom.json`);
  const file = fs.existsSync(custom) ? custom : path.join(rootDir(), "workflows", name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function workflowIdFromValue(value) {
  const text = String(value || "");
  return ["i2v", "r2v", "t2v"].includes(text) ? text : text.includes("参考") ? "r2v" : text.includes("图生") ? "i2v" : "t2v";
}

function workflowFileName(workflowId) {
  return { i2v: "MiniMax-H3-图生视频.json", r2v: "MiniMax-H3-参考生视频.json", t2v: "MiniMax-H3-文生视频.json" }[workflowId];
}

function validateWorkflowGraph(graph) {
  if (!graph || Array.isArray(graph) || typeof graph !== "object") return "工作流 JSON 格式不正确";
  const nodes = Object.values(graph);
  if (!nodes.length || nodes.length > 1000) return "工作流节点数量不合法";
  if (nodes.some((node) => !node || typeof node !== "object" || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object")) return "工作流节点格式不正确";
  if (!nodes.some((node) => node.class_type === "SaveVideo")) return "工作流缺少 SaveVideo 节点";
  if (!nodes.some((node) => ["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"].includes(node.class_type))) return "工作流缺少 MiniMax H3 视频节点";
  return "";
}

function customWorkflowPath(workflowId) {
  return path.join(rootDir(), "user", "workflows", `${workflowId}.custom.json`);
}

function defaultWorkflowPath(workflowId) {
  return path.join(rootDir(), "workflows", workflowFileName(workflowId));
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
  if (name.includes("r2v") || name.includes("参考")) return "r2v";
  if (name.includes("i2v") || name.includes("图生")) return "i2v";
  if (name.includes("t2v") || name.includes("文生") || name.includes("minimax_h3")) return "t2v";
  return "";
}

function listVideoFiles(limit = 100) {
  const outputDir = path.resolve(rootDir(), "output");
  if (!fs.existsSync(outputDir)) return [];
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(path.join(rootDir(), "user", "studio-history.json"), "utf8")); } catch (_) {}
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

async function runWorkflow(_event, { workflow, prompt, media, settings = {}, workflowGraph, jobId = "", id = "" }) {
  const task = { promptId: null, ws: null, canceled: false };
  activeTask = task;
  const graph = workflowGraph ? JSON.parse(JSON.stringify(workflowGraph)) : loadWorkflow(workflow);
  const progressJobId = jobId || id;
  const root = rootDir();
  const workflowId = workflow.includes("参考") ? "r2v" : workflow.includes("图生") ? "i2v" : "t2v";
  const beforeVideos = new Set(listVideoFiles(Infinity).map((item) => item.path));
  // ResolutionSelector rounds to the workflow's required multiple (32 in the bundled graphs).
  // These targets keep the three presets close to 480p, 720p and 1080p without changing the graph.
  const resolutionMap = { standard: 0.4, hd: 0.88, ultra: 2.0 };
  const aspectRatio = settings.aspectRatio === "9:16 (Portrait)" ? "9:16 (Portrait Widescreen)" : settings.aspectRatio;
  Object.values(graph).forEach((node) => {
    if (node.class_type === "ResolutionSelector") {
      if (aspectRatio) node.inputs.aspect_ratio = aspectRatio;
      if (settings.resolution && resolutionMap[settings.resolution]) node.inputs.megapixels = resolutionMap[settings.resolution];
    }
    if (node.class_type === "PrimitiveFloat" && Number.isFinite(Number(settings.duration))) node.inputs.value = Number(settings.duration);
    if (node.class_type === "SaveVideo") node.inputs.filename_prefix = `video/${workflowId}_MiniMax_H3`;
  });
  const uploaded = [];
  const cleanupUploaded = () => {
    for (const item of uploaded) {
      try { fs.unlinkSync(path.join(root, "input", item.filename)); } catch (_) {}
    }
  };
  try {
    for (let index = 0; index < (media || []).length; index += 1) {
      const item = media[index];
      if (!item) continue;
      if (task.canceled) throw new Error("任务已取消");
      const source = path.resolve(item);
      if (!fs.existsSync(source)) throw new Error(`找不到输入文件：${path.basename(source)}`);
      const filename = `app_${crypto.randomUUID().slice(0, 8)}_${path.basename(source)}`;
      fs.copyFileSync(source, path.join(root, "input", filename));
      uploaded.push({ filename, index });
    }
  } catch (error) {
    cleanupUploaded();
    throw error;
  }
  const imageNodes = Object.values(graph).filter((node) => node.class_type === "LoadImage");
  const referenceNodes = Object.values(graph).filter((node) => node.class_type === "MiniMaxH3ReferenceToVideo");
  referenceNodes.forEach((node) => {
    Object.keys(node.inputs).filter((key) => key.startsWith("ref_images.ref_image_")).forEach((key) => delete node.inputs[key]);
  });
  let nextNodeId = Math.max(0, ...Object.keys(graph).map((key) => Number(key)).filter(Number.isFinite)) + 1;
  uploaded.forEach(({ filename, index }) => {
    if (imageNodes[index]) imageNodes[index].inputs.image = filename;
    else {
      const nodeId = String(nextNodeId++);
      graph[nodeId] = { inputs: { image: filename }, class_type: "LoadImage", _meta: { title: "加载图像" } };
      referenceNodes.forEach((node) => { node.inputs[`ref_images.ref_image_${index}`] = [nodeId, 0]; });
    }
    referenceNodes.forEach((node) => {
      if (imageNodes[index]) node.inputs[`ref_images.ref_image_${index}`] = [String(Object.keys(graph).find((key) => graph[key] === imageNodes[index])), 0];
    });
  });
  // Remove template image nodes that are no longer connected after replacing references.
  const referencedNodeIds = new Set();
  Object.values(graph).forEach((node) => Object.values(node.inputs || {}).forEach((value) => {
    if (Array.isArray(value) && typeof value[0] === "string") referencedNodeIds.add(value[0]);
  }));
  Object.entries(graph).forEach(([id, node]) => {
    if (node.class_type === "LoadImage" && !referencedNodeIds.has(id)) delete graph[id];
  });
  Object.values(graph).forEach((node) => {
    if (["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"].includes(node.class_type)) node.inputs.prompt = prompt;
    if (node.class_type === "PrimitiveStringMultiline") node.inputs.value = prompt;
  });
  let promptId = null;
  let ws = null;
  let executionComplete = false;
  let currentNodeId = "";
  const completedNodeIds = new Set();
  const executionNodeIds = [];
  const totalNodeCount = Math.max(1, Object.keys(graph).length);
  const nodeLabel = (nodeId) => {
    const node = graph?.[String(nodeId)] || graph?.[nodeId];
    return node?._meta?.title || node?.class_type || "处理节点";
  };
  const overallProgress = (fraction = 0) => {
    const completed = completedNodeIds.size;
    const activeFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
    return Math.min(99, ((completed + activeFraction) / totalNodeCount) * 100);
  };
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
        if (data.prompt_id && promptId && data.prompt_id !== promptId) return;
        if (message.type === "executing" && data.node !== null && data.node !== undefined) {
          currentNodeId = String(data.display_node || data.node);
          const executionNodeId = String(data.display_node || data.node);
          if (!executionNodeIds.includes(executionNodeId)) executionNodeIds.push(executionNodeId);
          const label = nodeLabel(data.display_node || data.node);
          reportProgress(progressJobId, { value: overallProgress(0), max: 100, label: `正在执行：${label}`, node: label, nodeStep: Math.min(totalNodeCount, completedNodeIds.size + 1), nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 });
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
          reportProgress(progressJobId, { value: overallProgress(step / Math.max(1, stepMax)), max: 100, label: `正在执行：${label}`, node: label, nodeStep: Math.min(totalNodeCount, completedNodeIds.size + 1), nodeTotal: totalNodeCount, detailStep: step, detailStepMax: stepMax });
        }
        if (message.type === "executed" && data.node !== null && data.node !== undefined) {
          const nodeId = String(data.node);
          completedNodeIds.add(nodeId);
          currentNodeId = String(data.display_node || data.node);
          const label = nodeLabel(data.display_node || data.node);
          reportProgress(progressJobId, { value: overallProgress(0), max: 100, label: `已完成：${label}`, node: label, nodeStep: Math.min(totalNodeCount, completedNodeIds.size), nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 });
        }
        if (message.type === "executing" && data.node === null && promptId && (!data.prompt_id || data.prompt_id === promptId)) { executionComplete = true; const update = { value: 100, max: 100, label: "完成", node: "完成", nodeStep: totalNodeCount, nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 }; reportProgress(progressJobId, update); ws.close(); }
      } catch (_) {}
    });
  } catch (_) {
    ws = null;
  }
  try {
    reportProgress(progressJobId, { value: 0, max: 100, label: "已提交，等待后端进度", node: "等待后端进度", nodeStep: 0, nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 });
    const result = await requestJson("POST", "/prompt", { prompt: graph, client_id: clientId });
    if (result.error) throw new Error(result.error);
    promptId = result.prompt_id;
    task.promptId = promptId;
    if (task.canceled) {
      try { await requestJson("POST", "/interrupt", {}); } catch (_) {}
      throw new Error("任务已取消");
    }
    for (let i = 0; i < 3600; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (task.canceled) throw new Error("任务已取消");
      const history = await requestJson("GET", `/history/${encodeURIComponent(promptId)}`);
      if (history[promptId]) {
        if (activeTask === task) activeTask = { promptId: null, ws: null };
        const status = history[promptId].status || {};
        if (status.status_str === "error" || status.status_str === "execution_error") throw new Error("ComfyUI 执行失败，请查看 logs/backend.log");
        const completed = history[promptId];
        const outputDir = path.resolve(root, "output");
        const metadataPath = path.join(root, "user", "studio-history.json");
        let metadata = {};
        try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch (_) {}
        for (const item of listVideoFiles(Infinity).filter((video) => !beforeVideos.has(video.path))) {
          const relative = path.relative(outputDir, item.path).replace(/\\/g, "/");
          metadata[relative] = { workflow: workflowId, prompt, duration: settings.duration || 5, resolution: settings.resolution || "standard", aspectRatio: settings.aspectRatio || "" };
        }
        try { fs.mkdirSync(path.dirname(metadataPath), { recursive: true }); fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2)); } catch (_) {}
        reportProgress(progressJobId, { value: 100, max: 100, label: "完成", node: "完成", nodeStep: totalNodeCount, nodeTotal: totalNodeCount, detailStep: 0, detailStepMax: 0 });
        const generated = listVideoFiles(Infinity).filter((video) => !beforeVideos.has(video.path));
        return { ...completed, outputPath: generated[0]?.path || "" };
      }
    }
    throw new Error("任务等待超时");
  } finally {
    cleanupUploaded();
  }
}

const queueWorkflowNames = { i2v: "图生视频", r2v: "参考生视频", t2v: "文生视频" };

async function processQueue() {
  if (queueWorkerPromise || queuePaused || !backendReady) return;
  queueWorkerPromise = (async () => {
    const jobs = readQueueJobs();
    while (!queuePaused && backendReady) {
      const job = jobs.find((item) => item.state === "queued");
      if (!job) break;
      job.state = "preparing";
      job.attempts = (job.attempts || 0) + 1;
      job.error = "";
      setJobProgress(job, { value: 0, max: 100, label: "准备中" });
      writeQueueJobs();
      emitQueue();
      activeQueueJobId = job.id;
      job.state = "running";
      job.startedAt = Date.now();
      setJobProgress(job, { value: 0, max: 100, label: "生成中" });
      writeQueueJobs();
      emitQueue();
      try {
        const result = await runWorkflow(null, { ...job, jobId: job.id });
        job.state = "completed";
        job.outputPath = result?.outputPath || "";
        job.progress = { value: 100, max: 100, label: "已完成" };
        job.completedAt = Date.now();
      } catch (error) {
        job.state = job.cancelRequested ? "cancelled" : "failed";
        job.error = job.cancelRequested ? "已取消" : (error?.message || "生成失败");
        job.progress = { value: 0, max: 100, label: job.state === "cancelled" ? "已取消" : "失败" };
        job.completedAt = Date.now();
      } finally {
        delete job.cancelRequested;
        activeQueueJobId = "";
        activeTask = { promptId: null, ws: null };
        writeQueueJobs();
        emitQueue();
        if (job.state === "completed") emit("queue-completed", publicQueueJob(job));
        if (job.state === "failed") emit("queue-failed", publicQueueJob(job));
      }
    }
  })().finally(() => { queueWorkerPromise = null; });
  return queueWorkerPromise;
}

async function enqueueWorkflow(payload) {
  if (!backendReady) throw new Error("本地引擎尚未就绪");
  const workflowId = workflowIdFromValue(payload?.workflow);
  const workflowConfig = readWorkflowConfig(workflowId);
  if (!workflowConfig.ok) throw new Error(workflowConfig.error || "读取工作流失败");
  let workflowGraph;
  try { workflowGraph = JSON.parse(workflowConfig.content); } catch (error) { throw new Error(`工作流 JSON 格式不正确：${error.message}`); }
  const validation = validateWorkflowGraph(workflowGraph);
  if (validation) throw new Error(validation);
  const id = crypto.randomUUID();
  const media = await stageQueueMedia(id, payload?.media || []);
  const job = {
    id,
    workflowId,
    workflowName: queueWorkflowNames[workflowId],
    workflow: workflowFileName(workflowId),
    workflowGraph,
    prompt: String(payload?.prompt || ""),
    media,
    sourceMedia: (payload?.media || []).map((item) => path.resolve(String(item || ""))),
    settings: payload?.settings || {},
    state: "queued",
    progress: { value: 0, max: 100, label: "排队中" },
    createdAt: Date.now(),
    startedAt: 0,
    completedAt: 0,
    attempts: 0,
    error: "",
    outputPath: "",
  };
  readQueueJobs().push(job);
  writeQueueJobs();
  emitQueue();
  const position = readQueueJobs().filter((item) => item.state === "queued").findIndex((item) => item.id === id) + 1;
  processQueue();
  return { ok: true, job: publicQueueJob(job, position), position };
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
    createWindow();
    try { await startBackend(); } catch (error) { emit("status", error.message); }
  });
}
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  if (backend && !backend.killed) backend.kill();
  if (backendLogFd !== null) { try { fs.closeSync(backendLogFd); } catch (_) {} backendLogFd = null; }
});

ipcMain.handle("pick-file", async (_event, kind) => {
  const filters = kind === "video" ? [{ name: "图片或视频", extensions: ["png", "jpg", "jpeg", "webp", "mp4", "mov"] }] : [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }];
  const result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters });
  return result.canceled ? "" : result.filePaths[0];
});
ipcMain.handle("pick-files", async (_event, kind) => {
  const filters = kind === "image" ? [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "avif"] }] : [{ name: "文件", extensions: ["*"] }];
  const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle("backend-url", () => backendReady && port ? `http://127.0.0.1:${port}` : "");
ipcMain.handle("load-workflow-config", (_event, workflowId) => readWorkflowConfig(workflowId));
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
ipcMain.handle("list-queue", () => queueSnapshot());
ipcMain.handle("queue-paused", () => queuePaused);
ipcMain.handle("pause-queue", () => {
  queuePaused = true;
  const persisted = writeQueuePaused(true);
  emitQueue();
  return { ok: persisted, paused: true, error: persisted ? "" : "暂停状态保存失败" };
});
ipcMain.handle("resume-queue", () => {
  queuePaused = false;
  const persisted = writeQueuePaused(false);
  processQueue();
  emitQueue();
  return { ok: persisted, paused: false, error: persisted ? "" : "继续状态保存失败" };
});
ipcMain.handle("cancel-queue-item", async (_event, jobId) => {
  const job = readQueueJobs().find((item) => item.id === String(jobId || ""));
  if (!job || ["completed", "failed", "cancelled"].includes(job.state)) return { ok: false, error: "任务当前不可取消" };
  if (job.id === activeQueueJobId) {
    job.cancelRequested = true;
    activeTask.canceled = true;
    if (activeTask.promptId) { try { await requestJson("POST", "/interrupt", {}); } catch (_) {} }
    if (activeTask.ws) activeTask.ws.close();
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
    const existingMedia = (Array.isArray(job.media) ? job.media : []).filter((file) => {
      try { return Boolean(file) && fs.existsSync(file); } catch (_) { return false; }
    });
    const expectedCount = Array.isArray(job.sourceMedia) ? job.sourceMedia.length : existingMedia.length;
    job.media = existingMedia.length === expectedCount ? existingMedia : await stageQueueMedia(job.id, job.sourceMedia || []);
  }
  catch (error) { return { ok: false, error: error.message }; }
  job.state = "queued";
  job.error = "";
  job.outputPath = "";
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
  if (task.promptId) {
    try { await requestJson("POST", "/interrupt", {}); } catch (_) {}
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
  const items = listVideoFiles();
  const metadataPath = path.join(rootDir(), "user", "studio-history.json");
  let metadata = {};
  let changed = false;
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch (_) {}
  for (const item of items) {
    const relative = path.relative(path.resolve(rootDir(), "output"), item.path).replace(/\\/g, "/");
    if (!metadata[relative] && item.workflow) { metadata[relative] = { workflow: item.workflow }; changed = true; }
  }
  if (changed) { try { fs.mkdirSync(path.dirname(metadataPath), { recursive: true }); fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2)); } catch (_) {} }
  return items;
});
ipcMain.handle("app-version", () => app.getVersion());
ipcMain.handle("check-update", async () => {
  if (process.platform !== "win32") return { ok: true, currentVersion: app.getVersion(), latestVersion: app.getVersion(), hasUpdate: false, unsupported: true };
  try { return { ok: true, ...(await getUpdateInfo()) }; }
  catch (error) {
    if (error.statusCode === 404) { const currentVersion = app.getVersion(); return { ok: true, currentVersion, latestVersion: currentVersion, hasUpdate: false, noRelease: true }; }
    return { ok: false, error: error.message };
  }
});
ipcMain.handle("update-app", async () => {
  if (process.platform !== "win32") return { ok: false, error: "当前便携引擎仅支持 Windows，Mac 版本暂不可更新" };
  let tempPath = "";
  try {
    const info = await getUpdateInfo();
    if (!info.hasUpdate) return { ok: false, error: "当前已是最新版本" };
    const release = await latestRelease();
    const asset = (release.assets || []).find((item) => isUpdateAsset(item.name));
    if (!asset?.browser_download_url) return { ok: false, error: "Release 中没有找到 exe 更新包" };
    const updateDir = path.join(rootDir(), ".updates");
    fs.mkdirSync(updateDir, { recursive: true });
    tempPath = path.join(updateDir, "MiniMax H3 Studio.exe.download");
    const targetPath = path.join(rootDir(), "MiniMax H3 Studio.exe");
    await downloadFile(asset.browser_download_url, tempPath);
    verifyUpdateAsset(tempPath, asset);
    const command = `/d /c ping 127.0.0.1 -n 3 > nul & move /Y "${tempPath}" "${targetPath}" > nul & start "" "${targetPath}"`;
    spawn(process.env.ComSpec || "cmd.exe", [command], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    setTimeout(() => app.quit(), 150);
    return { ok: true, updating: true, version: info.latestVersion };
  } catch (error) {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
    return { ok: false, error: error.message };
  }
});
ipcMain.handle("delete-video", async (_event, filePath) => {
  const target = outputFilePath(filePath);
  if (!target || !fs.existsSync(target)) return { ok: false, error: "无效的输出文件" };
  const result = await dialog.showMessageBox(win, { type: "warning", buttons: ["取消", "删除"], defaultId: 0, cancelId: 0, title: "删除视频", message: `确定删除“${path.basename(target)}”吗？` });
  if (result.response !== 1) return { ok: false, canceled: true };
  try {
    fs.unlinkSync(target);
    const outputDir = path.resolve(rootDir(), "output");
    const metadataPath = path.join(rootDir(), "user", "studio-history.json");
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      delete metadata[path.relative(outputDir, target).replace(/\\/g, "/")];
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (_) {}
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle("clear-videos", async (_event, workflowId = "") => {
  const items = listVideoFiles(Infinity).filter((item) => !workflowId || item.workflow === workflowId);
  if (!items.length) return { ok: true, count: 0 };
  const result = await dialog.showMessageBox(win, { type: "warning", buttons: ["取消", "全部删除"], defaultId: 0, cancelId: 0, title: "清空最近生成", message: `确定删除最近生成中的 ${items.length} 个视频吗？` });
  if (result.response !== 1) return { ok: false, canceled: true };
  let count = 0;
  for (const item of items) {
    const target = outputFilePath(item.path);
    if (!target) continue;
    try { fs.unlinkSync(target); count += 1; } catch (_) {}
  }
  try {
    const metadataPath = path.join(rootDir(), "user", "studio-history.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    for (const item of items) delete metadata[path.relative(path.resolve(rootDir(), "output"), item.path).replace(/\\/g, "/")];
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  } catch (_) {}
  return { ok: true, count };
});
ipcMain.handle("open-video", (_event, filePath) => {
  const target = outputFilePath(filePath);
  return target ? shell.openPath(target) : Promise.resolve("无效的输出文件");
});
ipcMain.handle("file-url", (_event, filePath) => {
  const target = path.resolve(String(filePath || ""));
  return fs.existsSync(target) ? pathToFileURL(target).href : "";
});
