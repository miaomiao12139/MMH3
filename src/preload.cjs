const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("studio", {
  pickFile: (kind) => ipcRenderer.invoke("pick-file", kind),
  pickFiles: (kind) => ipcRenderer.invoke("pick-files", kind),
  getPathForFile: (file) => {
    try { return webUtils?.getPathForFile?.(file) || file?.path || ""; }
    catch (_) { return file?.path || ""; }
  },
  getVoiceState: () => ipcRenderer.invoke("voice-state"),
  listVoices: () => ipcRenderer.invoke("list-voices"),
  generateVoice: payload => ipcRenderer.invoke("generate-voice", payload),
  cancelVoice: () => ipcRenderer.invoke("cancel-voice"),
  deleteVoice: file => ipcRenderer.invoke("delete-voice", file),
  clearVoices: () => ipcRenderer.invoke("clear-voices"),
  revealVoice: file => ipcRenderer.invoke("reveal-voice", file),
  exportVoice: file => ipcRenderer.invoke("export-voice", file),
  openVoiceFolder: () => ipcRenderer.invoke("open-voice-folder"),
  getAiToolsState: () => ipcRenderer.invoke("ai-tools-state"),
  runAiTool: payload => ipcRenderer.invoke("run-ai-tool", payload),
  cancelAiTool: () => ipcRenderer.invoke("cancel-ai-tool"),
  onAiToolProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("ai-tool-progress", listener);
    return () => ipcRenderer.removeListener("ai-tool-progress", listener);
  },
  onVoiceProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("voice-progress", listener);
    return () => ipcRenderer.removeListener("voice-progress", listener);
  },
  getBackendUrl: () => ipcRenderer.invoke("backend-url"),
  getEngineState: () => ipcRenderer.invoke("engine-state"),
  getReferenceCapabilities: () => ipcRenderer.invoke("reference-capabilities"),
  preflightWorkflow: (payload) => ipcRenderer.invoke("preflight-workflow", payload),
  loadWorkflowConfig: (workflowId) => ipcRenderer.invoke("load-workflow-config", workflowId),
  getGenerationStyles: () => ipcRenderer.invoke("generation-styles"),
  pickWorkflowJson: () => ipcRenderer.invoke("pick-workflow-json"),
  saveWorkflowConfig: (workflowId, content) => ipcRenderer.invoke("save-workflow-config", workflowId, content),
  resetWorkflowConfig: (workflowId) => ipcRenderer.invoke("reset-workflow-config", workflowId),
  run: (payload) => ipcRenderer.invoke("run-workflow", payload),
  enqueue: (payload) => ipcRenderer.invoke("enqueue-workflow", payload),
  runCutoutBatch: (payload) => ipcRenderer.invoke("run-cutout-batch", payload),
  cancelCutoutBatch: () => ipcRenderer.invoke("cancel-cutout-batch"),
  listQueue: () => ipcRenderer.invoke("list-queue"),
  reorderQueueItem: (jobId, targetIndex) => ipcRenderer.invoke("reorder-queue-item", jobId, targetIndex),
  isQueuePaused: () => ipcRenderer.invoke("queue-paused"),
  getQueueRetentionDays: () => ipcRenderer.invoke("queue-retention-days"),
  setQueueRetentionDays: (days) => ipcRenderer.invoke("set-queue-retention-days", days),
  pauseQueue: () => ipcRenderer.invoke("pause-queue"),
  resumeQueue: () => ipcRenderer.invoke("resume-queue"),
  cancelQueueItem: (jobId) => ipcRenderer.invoke("cancel-queue-item", jobId),
  removeQueueItem: (jobId) => ipcRenderer.invoke("remove-queue-item", jobId),
  retryQueueItem: (jobId) => ipcRenderer.invoke("retry-queue-item", jobId),
  clearQueue: (mode) => ipcRenderer.invoke("clear-queue", mode),
  setAudioMuted: (muted) => ipcRenderer.invoke("set-audio-muted", Boolean(muted)),
  cancel: () => ipcRenderer.invoke("cancel-workflow"),
  openOutput: () => ipcRenderer.invoke("open-output"),
  listVideos: () => ipcRenderer.invoke("list-videos"),
  listCutouts: () => ipcRenderer.invoke("list-cutouts"),
  exportCutoutBatch: (ids) => ipcRenderer.invoke("export-cutout-batch", ids),
  clearCutouts: () => ipcRenderer.invoke("clear-cutouts"),
  deleteCutout: (id) => ipcRenderer.invoke("delete-cutout", id),
  deleteVideo: (filePath) => ipcRenderer.invoke("delete-video", filePath),
  clearVideos: (workflowId) => ipcRenderer.invoke("clear-videos", workflowId),
  setVideoFavorite: (filePath, favorite) => ipcRenderer.invoke("set-video-favorite", filePath, Boolean(favorite)),
  getAppVersion: () => ipcRenderer.invoke("app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-update"),
  updateApp: () => ipcRenderer.invoke("update-app"),
  openVideo: (filePath) => ipcRenderer.invoke("open-video", filePath),
  fileUrl: (filePath) => ipcRenderer.invoke("file-url", filePath),
  stageAsset: (filePath) => ipcRenderer.invoke("stage-asset", filePath),
  loadPreferences: (legacy) => ipcRenderer.invoke("load-preferences", legacy),
  savePreference: (key, value) => ipcRenderer.invoke("save-preference", key, value),
  pruneAssets: (removedPaths) => ipcRenderer.invoke("prune-assets", removedPaths),
  saveClipboardImage: (payload) => ipcRenderer.invoke("save-clipboard-image", payload),
  revealVideo: (filePath) => ipcRenderer.invoke("reveal-video", filePath),
  copyPath: (filePath) => ipcRenderer.invoke("copy-path", filePath),
  renameVideo: (filePath, name) => ipcRenderer.invoke("rename-video", filePath, name),
  exportVideo: (filePath) => ipcRenderer.invoke("export-video", filePath),
  openDirectory: (kind) => ipcRenderer.invoke("open-directory", kind),
  engineHealth: () => ipcRenderer.invoke("engine-health"),
  storageUsage: () => ipcRenderer.invoke("storage-usage"),
  listWorkflowBackups: (workflowId) => ipcRenderer.invoke("list-workflow-backups", workflowId),
  restoreWorkflowBackup: (workflowId, backupId) => ipcRenderer.invoke("restore-workflow-backup", workflowId, backupId),
  exportConfig: (payload) => ipcRenderer.invoke("export-config", payload),
  importConfig: () => ipcRenderer.invoke("import-config"),
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
  onStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("status", listener);
    return () => ipcRenderer.removeListener("status", listener);
  },
  onProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },
  onQueueUpdated: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("queue-updated", listener);
    return () => ipcRenderer.removeListener("queue-updated", listener);
  },
  onQueueControl: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("queue-control", listener);
    return () => ipcRenderer.removeListener("queue-control", listener);
  },
  onQueueCompleted: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("queue-completed", listener);
    return () => ipcRenderer.removeListener("queue-completed", listener);
  },
  onQueueFailed: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("queue-failed", listener);
    return () => ipcRenderer.removeListener("queue-failed", listener);
  },
  onCutoutProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("cutout-progress", listener);
    return () => ipcRenderer.removeListener("cutout-progress", listener);
  },
  onCutoutStarted: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("cutout-started", listener);
    return () => ipcRenderer.removeListener("cutout-started", listener);
  },
  onCutoutCompleted: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("cutout-completed", listener);
    return () => ipcRenderer.removeListener("cutout-completed", listener);
  },
  onCutoutFailed: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("cutout-failed", listener);
    return () => ipcRenderer.removeListener("cutout-failed", listener);
  },
});
