const fs = require("fs");
const path = require("path");
const { relocateStoredPaths, restoreDraftAssets } = require("./runtime.cjs");
const DRAFTS_KEY = "minimax-h3-workflow-drafts-v1";
const COPIES_KEY = "minimax-h3-asset-copies-v1";
const objectValue = value => value && typeof value === "object" && !Array.isArray(value);

function validatePreference(key, raw) {
  const arrays = [COPIES_KEY, "minimax-h3-asset-library-v1", "minimax-h3-video-favorites-v1", "minimax-h3-prompt-presets-v1"];
  const objects = [DRAFTS_KEY, "minimax-h3-profile", "minimax-h3-prompt-history-v1", "minimax-h3-cutout-options-v1"];
  if (!arrays.includes(key) && !objects.includes(key)) return;
  const value = JSON.parse(raw);
  if (arrays.includes(key) ? !Array.isArray(value) : !objectValue(value)) throw new Error(`配置项格式无效：${key}`);
  if (key === COPIES_KEY && value.some(item => !objectValue(item) || typeof item.sourcePath !== "string" || typeof item.path !== "string")) throw new Error("素材副本映射格式无效");
  if (key === DRAFTS_KEY) for (const draft of Object.values(value)) {
    if (!objectValue(draft) || ["files", "previews"].some(field => draft[field] !== undefined && (!Array.isArray(draft[field]) || draft[field].some(file => typeof file !== "string")))) throw new Error("工作流草稿格式无效");
  }
  if (key === "minimax-h3-profile" && ["name", "avatar"].some(field => value[field] !== undefined && typeof value[field] !== "string")) throw new Error("用户资料格式无效");
}

function createPreferenceStore(rootDir, writeText) {
  let state;
  let timer;
  const location = () => path.join(rootDir(), "user", "studio-preferences.json");
  function flush() {
    clearTimeout(timer);
    if (!state) return;
    fs.mkdirSync(path.dirname(location()), { recursive: true });
    writeText(location(), JSON.stringify({ runtimeRoot: rootDir(), values: state }, null, 2));
  }
  function load(legacy = {}) {
    if (state) return state;
    let stored;
    if (fs.existsSync(location())) {
      // Never overwrite a damaged settings file with empty defaults.
      stored = JSON.parse(fs.readFileSync(location(), "utf8"));
    }
    const previousRoot = stored?.runtimeRoot || "";
    const next = {};
    if (stored !== undefined && (!objectValue(stored) || !objectValue(stored.values))) throw new Error("配置文件结构无效");
    for (const [key, raw] of Object.entries(stored?.values || legacy)) {
      if (!key.startsWith("minimax-h3-") || typeof raw !== "string") continue;
      validatePreference(key, raw);
      try { next[key] = JSON.stringify(relocateStoredPaths(JSON.parse(raw), rootDir(), previousRoot, key)); }
      catch (_) { next[key] = raw; }
    }
    const oldLibrary = JSON.parse(next["minimax-h3-asset-library-v1"] || "[]");
    if (!next[COPIES_KEY]) next[COPIES_KEY] = JSON.stringify(oldLibrary.filter((item) => item?.sourcePath && item?.path));
    validatePreference(COPIES_KEY, next[COPIES_KEY]);
    if (next[DRAFTS_KEY]) next[DRAFTS_KEY] = JSON.stringify(restoreDraftAssets(JSON.parse(next[DRAFTS_KEY]), JSON.parse(next[COPIES_KEY])));
    fs.mkdirSync(path.dirname(location()), { recursive: true });
    writeText(location(), JSON.stringify({ runtimeRoot: rootDir(), values: next }, null, 2));
    state = next;
    return state;
  }
  function save(key, value) {
    if (!String(key).startsWith("minimax-h3-") || typeof value !== "string") throw new Error("无效的配置项");
    if (!state) load();
    validatePreference(key, value);
    state[key] = key === DRAFTS_KEY ? JSON.stringify(restoreDraftAssets(JSON.parse(value), JSON.parse(state[COPIES_KEY] || "[]"))) : value;
    clearTimeout(timer);
    timer = setTimeout(() => { try { flush(); } catch (error) { console.error("配置保存失败", error); } }, 250);
    return { ok: true };
  }
  function values() { return state || {}; }
  function registerAsset(sourcePath, assetPath) {
    if (!state) load();
    const copies = JSON.parse(state[COPIES_KEY] || "[]").filter((item) => item.sourcePath.toLowerCase() !== sourcePath.toLowerCase() && fs.existsSync(item.path));
    copies.push({ sourcePath, path: assetPath });
    save(COPIES_KEY, JSON.stringify(copies));
    if (state[DRAFTS_KEY]) save(DRAFTS_KEY, state[DRAFTS_KEY]);
  }
  return { load, save, flush, values, registerAsset };
}

module.exports = { createPreferenceStore };
