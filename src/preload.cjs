const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("studio", {
  pickFile: (kind) => ipcRenderer.invoke("pick-file", kind),
  pickFiles: (kind) => ipcRenderer.invoke("pick-files", kind),
  getBackendUrl: () => ipcRenderer.invoke("backend-url"),
  loadWorkflowConfig: (workflowId) => ipcRenderer.invoke("load-workflow-config", workflowId),
  pickWorkflowJson: () => ipcRenderer.invoke("pick-workflow-json"),
  saveWorkflowConfig: (workflowId, content) => ipcRenderer.invoke("save-workflow-config", workflowId, content),
  resetWorkflowConfig: (workflowId) => ipcRenderer.invoke("reset-workflow-config", workflowId),
  run: (payload) => ipcRenderer.invoke("run-workflow", payload),
  enqueue: (payload) => ipcRenderer.invoke("enqueue-workflow", payload),
  listQueue: () => ipcRenderer.invoke("list-queue"),
  isQueuePaused: () => ipcRenderer.invoke("queue-paused"),
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
  deleteVideo: (filePath) => ipcRenderer.invoke("delete-video", filePath),
  clearVideos: (workflowId) => ipcRenderer.invoke("clear-videos", workflowId),
  getAppVersion: () => ipcRenderer.invoke("app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-update"),
  updateApp: () => ipcRenderer.invoke("update-app"),
  openVideo: (filePath) => ipcRenderer.invoke("open-video", filePath),
  fileUrl: (filePath) => ipcRenderer.invoke("file-url", filePath),
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
});
