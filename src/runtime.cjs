const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

function resolveRuntimeRoot({ portableDir, executableDir, resourcesDir, developmentDir, exists = fs.existsSync }) {
  const candidates = [];
  const add = (directory) => {
    if (directory && !candidates.includes(path.resolve(directory))) candidates.push(path.resolve(directory));
  };
  for (const origin of [portableDir, developmentDir, executableDir, resourcesDir]) {
    if (!origin) continue;
    let parent = path.resolve(origin);
    for (let depth = 0; depth < 6; depth += 1) {
      add(parent);
      add(path.join(parent, "App"));
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  return candidates.find((directory) => exists(path.join(directory, "python", "python.exe")) && exists(path.join(directory, "ComfyUI", "main.py")))
    || path.resolve(portableDir || developmentDir || executableDir);
}

function isInside(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const storedPathKeys = new Set(["path", "filePath", "sourcePath", "outputPath", "fileUrl", "thumbnailUrl", "sourceUrl", "url", "files", "previews", "media", "sourceMedia", "outputPaths", "videoFavorites", "minimax-h3-video-favorites-v1"]);

function relocatePath(value, root, previousRoot = "") {
  if (typeof value !== "string" || !value) return value;
  const isUrl = value.startsWith("file:");
  let source;
  try { source = isUrl ? fileURLToPath(value) : value; } catch (_) { return value; }
  if (!path.isAbsolute(source)) return value;
  let relative = "";
  if (previousRoot && isInside(previousRoot, source)) relative = path.relative(previousRoot, source);
  else {
    // Older versions did not save the runtime root alongside their records.
    const legacy = source.replace(/\\/g, "/").match(/\/App\/(user|input|output)\/(.+)$/i);
    if (legacy) relative = path.join(legacy[1].toLowerCase(), legacy[2]);
  }
  if (!relative || !/^(user|input|output)[\\/]/i.test(relative)) return value;
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) return value;
  return isUrl ? pathToFileURL(target).href : target;
}

function relocateStoredPaths(value, root, previousRoot = "", key = "") {
  if (typeof value === "string") return storedPathKeys.has(key) ? relocatePath(value, root, previousRoot) : value;
  if (Array.isArray(value)) return value.map((item) => relocateStoredPaths(item, root, previousRoot, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, relocateStoredPaths(item, root, previousRoot, name)]));
  return value;
}

function restoreDraftAssets(drafts, copies) {
  const resolve = (value) => {
    if (typeof value !== "string" || !value) return value;
    let source = value;
    try { if (source.startsWith("file:")) source = fileURLToPath(source); } catch (_) { return value; }
    const match = copies.find((item) => path.resolve(item.sourcePath).toLowerCase() === path.resolve(source).toLowerCase());
    if (!match || !fs.existsSync(match.path)) return value;
    return value.startsWith("file:") ? pathToFileURL(match.path).href : match.path;
  };
  const visit = (value, key = "") => {
    if (typeof value === "string") return storedPathKeys.has(key) ? resolve(value) : value;
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  return visit(drafts);
}

async function cancelPrompt(requestJson, promptId) {
  if (!promptId) return;
  // Deleting a pending prompt first also covers it starting during cancellation.
  await requestJson("POST", "/queue", { delete: [promptId] });
  await requestJson("POST", "/interrupt", { prompt_id: promptId });
}

function cancelTask(requestJson, task, owner = null, ownerFlag = "canceled") {
  if (task.cancellation) return task.cancellation;
  const pending = Promise.resolve().then(async () => {
    if (task.promptId) await cancelPrompt(requestJson, task.promptId);
    task.canceled = true;
    if (owner) owner[ownerFlag] = true;
    // Engine acknowledgement owns the cancellation result; closing an already
    // finished local handle must not turn an accepted cancellation into failure.
    try { task.preparation?.kill(); } catch (_) {}
    try { task.ws?.close(); } catch (_) {}
    return { ok: true };
  }).finally(() => { if (task.cancellation === pending) delete task.cancellation; });
  task.cancellation = pending;
  return pending;
}

function describeEngineError(payload, fallback = "本地引擎执行失败") {
  const messages = [];
  const add = value => { if (typeof value === "string" && value.trim()) messages.push(value.trim()); };
  const error = payload?.error;
  if (typeof error === "string") add(error);
  else { add(error?.message); add(error?.details); }
  for (const [id, entry] of Object.entries(payload?.node_errors || {})) {
    for (const issue of entry.errors || []) add(`节点 ${entry.class_type || id}：${issue.message || "参数无效"}${issue.details ? `（${issue.details}）` : ""}`);
  }
  for (const [kind, data] of payload?.status?.messages || []) {
    if (kind === "execution_error") add(`${data.node_type || data.node_id || "节点"}：${data.exception_message || "执行失败"}`);
    if (kind === "execution_interrupted") add("任务已被引擎中断");
  }
  return (messages.length ? [...new Set(messages)].join("；") : fallback).slice(0, 1600);
}

module.exports = { resolveRuntimeRoot, isInside, relocatePath, relocateStoredPaths, restoreDraftAssets, cancelPrompt, cancelTask, describeEngineError };
