import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const workflows = [
  { id: "i2v", name: "图生视频", file: "MiniMax-H3-图生视频.json", media: 1, icon: "◩" },
  { id: "r2v", name: "参考生视频", file: "MiniMax-H3-参考生视频.json", media: 9, icon: "◈" },
  { id: "t2v", name: "文生视频", file: "MiniMax-H3-文生视频.json", media: 0, icon: "✦" },
];

const imageExtensions = /\.(png|jpe?g|webp|avif)$/i;

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function readProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem("minimax-h3-profile") || "{}");
    return { name: saved.name || "创作者", avatar: saved.avatar || "" };
  } catch (_) {
    return { name: "创作者", avatar: "" };
  }
}

function queueStateLabel(state) {
  return { queued: "排队中", preparing: "准备中", running: "生成中", completed: "已完成", failed: "生成失败", cancelled: "已取消", interrupted: "已中断" }[state] || state;
}

function queueTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const COMFY_EMBED_WORKFLOW_PATH = "h3-studio-workflow";

function createComfyGuestScript(graph, workflowName, requestId, loadGraph = true) {
  const payload = loadGraph ? JSON.stringify(graph) : "null";
  const namePayload = JSON.stringify(workflowName || "工作流");
  const loadBlock = loadGraph ? `
    const apiGraph = ${payload};
      const workflowName = ${namePayload};
      const workflowPath = ${JSON.stringify(COMFY_EMBED_WORKFLOW_PATH)};
    let tries = 0;
    const load = () => {
      if (Number(window.__h3WorkflowRequest || 0) !== requestId) return true;
      const comfyApp = window.comfyAPI?.app?.app || window.app;
      // ComfyUI exposes the app object before its root graph is initialized.
      // Waiting for the graph prevents a rejected load from leaving the old workflow visible.
      if (!comfyApp?.loadApiJson || !comfyApp?.isGraphReady || !comfyApp?.canvas) return false;
      window.__h3Fit = () => fitCanvas(comfyApp.canvas, comfyApp);
      Promise.resolve(comfyApp.loadApiJson(apiGraph, workflowPath)).then(() => {
        if (Number(window.__h3WorkflowRequest || 0) !== requestId) return;
        window.__h3WorkflowDisplayName = workflowName;
        applyWorkflowLabel();
        let fits = 0;
        const fitTimer = setInterval(() => {
          if (Number(window.__h3WorkflowRequest || 0) !== requestId) { clearInterval(fitTimer); return; }
          fitCanvas(comfyApp.canvas, comfyApp);
          if (++fits >= 12) { clearInterval(fitTimer); mountResizeObserver(comfyApp); }
        }, 350);
        requestAnimationFrame(() => fitCanvas(comfyApp.canvas, comfyApp));
      }).catch(() => {});
      return true;
    };
    const loadTimer = setInterval(() => {
      if (load()) clearInterval(loadTimer);
      else if (++tries > 120) clearInterval(loadTimer);
    }, 100);` : "";
  const requestGuard = loadGraph ? `
    if (Number(window.__h3WorkflowRequest || 0) > requestId) return true;
    window.__h3WorkflowRequest = requestId;` : "";
  return `(() => {
    const requestId = ${Number(requestId) || 0};${requestGuard}
    const hiddenSelectors = [
      '#comfyui-body-top', '.comfyui-body-top',
      '#comfyui-body-left', '.comfyui-body-left',
      '#comfyui-body-right', '.comfyui-body-right',
      '#comfyui-body-bottom', '.comfyui-body-bottom',
      '.litegraph-minimap', '.minimap-main-container', '.minimap-canvas',
      '[role="toolbar"]', '.canvas-toolbar', '.graph-canvas-toolbar'
    ];
    const displayWorkflowName = ${namePayload};
    if (displayWorkflowName) window.__h3WorkflowDisplayName = displayWorkflowName;
    const applyWorkflowLabel = () => {
      const name = window.__h3WorkflowDisplayName;
      if (!name || name === '工作流') return;
      document.querySelectorAll('.workflow-label').forEach((element) => {
        element.textContent = name;
      });
    };
    const installChrome = () => {
      const style = document.getElementById('h3-h3-canvas-only-style') || document.createElement('style');
      style.id = 'h3-h3-canvas-only-style';
      style.textContent = [
        'html,body,#vue-app{position:relative!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;overflow:hidden!important}',
        '#comfyui-body,.comfyui-body{display:block!important;position:relative!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;overflow:hidden!important}',
        '#graph-canvas-container,.graph-canvas-container{position:absolute!important;inset:0!important;display:block!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;overflow:hidden!important;z-index:0!important}',
        '#graph-canvas,.graph-canvas{position:absolute!important;inset:0!important;display:block!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important}',
        hiddenSelectors.join(',') + '{display:none!important;visibility:hidden!important;width:0!important;height:0!important;min-width:0!important;min-height:0!important;max-width:0!important;max-height:0!important;overflow:hidden!important;pointer-events:none!important}',
        '#graph-canvas-container > div[class*="absolute"][class*="z-999"]{display:none!important;visibility:hidden!important;pointer-events:none!important}',
        '#graph-canvas-container > div[class*="absolute"][class*="z-999"] *{display:none!important;visibility:hidden!important;pointer-events:none!important}',
        '#graph-canvas-container > :not(#graph-canvas){display:none!important;visibility:hidden!important;pointer-events:none!important}',
        'body [role="alert"],body [class*="toast"],body [class*="Toast"],body .p-toast,body .p-toast-container{display:none!important;visibility:hidden!important;pointer-events:none!important}',
        '.p-splitter-gutter,.splitter-overlay-bottom,.side-toolbar-container,.side-tool-bar-container,.sidebar-content-container,.bottom-panel,.side-bar-panel{display:none!important;visibility:hidden!important;pointer-events:none!important}'
      ].join('');
      if (!style.parentNode) document.head.appendChild(style);
      hiddenSelectors.forEach((selector) => document.querySelectorAll(selector).forEach((element) => {
        element.style.setProperty('display', 'none', 'important');
        element.style.setProperty('visibility', 'hidden', 'important');
        element.style.setProperty('width', '0', 'important');
        element.style.setProperty('height', '0', 'important');
        element.style.setProperty('min-width', '0', 'important');
        element.style.setProperty('min-height', '0', 'important');
        element.style.setProperty('max-width', '0', 'important');
        element.style.setProperty('max-height', '0', 'important');
      }));
      applyWorkflowLabel();
      const body = document.querySelector('#comfyui-body,.comfyui-body');
      if (body) {
        body.style.setProperty('display', 'block', 'important');
        body.style.setProperty('position', 'relative', 'important');
        body.style.setProperty('width', '100%', 'important');
        body.style.setProperty('height', '100%', 'important');
        body.style.setProperty('min-height', '0', 'important');
        body.style.setProperty('max-width', 'none', 'important');
        body.style.setProperty('max-height', 'none', 'important');
      }
      const root = document.querySelector('#vue-app');
      [document.documentElement, document.body, root].forEach((element) => {
        if (!element) return;
        element.style.setProperty('width', '100%', 'important');
        element.style.setProperty('height', '100%', 'important');
        element.style.setProperty('min-width', '0', 'important');
        element.style.setProperty('min-height', '0', 'important');
        element.style.setProperty('max-width', 'none', 'important');
        element.style.setProperty('max-height', 'none', 'important');
        element.style.setProperty('overflow', 'hidden', 'important');
      });
      const canvasContainer = document.querySelector('#graph-canvas-container,.graph-canvas-container');
      if (canvasContainer) {
        canvasContainer.style.setProperty('position', 'absolute', 'important');
        canvasContainer.style.setProperty('inset', '0', 'important');
        canvasContainer.style.setProperty('display', 'block', 'important');
        canvasContainer.style.setProperty('width', '100%', 'important');
        canvasContainer.style.setProperty('height', '100%', 'important');
        canvasContainer.style.setProperty('min-width', '0', 'important');
        canvasContainer.style.setProperty('min-height', '0', 'important');
        canvasContainer.style.setProperty('max-width', 'none', 'important');
        canvasContainer.style.setProperty('max-height', 'none', 'important');
        canvasContainer.style.setProperty('overflow', 'hidden', 'important');
      }
    };
    const fitCanvas = (canvas, comfyApp) => {
      if (!canvas) return;
      installChrome();
      // LiteGraph's resize() uses CSS pixels and would overwrite the retina canvas.
      // Run it before ComfyUI's DPR-aware resize so the final backing buffer stays full-size.
      canvas.resize?.();
      const graphCanvas = comfyApp?.canvasEl || document.querySelector('#graph-canvas');
      if (graphCanvas) {
        graphCanvas.style.setProperty('position', 'absolute', 'important');
        graphCanvas.style.setProperty('inset', '0', 'important');
        graphCanvas.style.setProperty('display', 'block', 'important');
        graphCanvas.style.setProperty('width', '100%', 'important');
        graphCanvas.style.setProperty('height', '100%', 'important');
        graphCanvas.style.setProperty('min-width', '0', 'important');
        graphCanvas.style.setProperty('min-height', '0', 'important');
        graphCanvas.style.setProperty('max-width', 'none', 'important');
        graphCanvas.style.setProperty('max-height', 'none', 'important');
        // Resize only after the CSS box is in its final viewport-sized state.
        comfyApp?.resizeCanvas?.(graphCanvas);
        const rect = graphCanvas.getBoundingClientRect();
        const scale = Math.max(window.devicePixelRatio || 1, 1);
        const width = Math.max(1, Math.round(rect.width * scale));
        const height = Math.max(1, Math.round(rect.height * scale));
        if (rect.width > 0 && rect.height > 0 && (graphCanvas.width !== width || graphCanvas.height !== height)) {
          graphCanvas.width = width;
          graphCanvas.height = height;
          graphCanvas.getContext('2d')?.setTransform(scale, 0, 0, scale, 0, 0);
        }
      }
      const nodes = canvas.graph?._nodes || comfyApp?.rootGraph?._nodes || [];
      if (canvas.ds && nodes.length) {
        const bounds = nodes.reduce((out, node) => {
          const x = Number(node.pos?.[0] || 0);
          const y = Number(node.pos?.[1] || 0);
          const width = Number(node.size?.[0] || 240);
          const height = Number(node.size?.[1] || 120);
          out[0] = Math.min(out[0], x);
          out[1] = Math.min(out[1], y);
          out[2] = Math.max(out[2], x + width);
          out[3] = Math.max(out[3], y + height);
          return out;
        }, [Infinity, Infinity, -Infinity, -Infinity]);
        if (bounds.every(Number.isFinite)) {
          canvas.ds.fitToBounds([bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]], { zoom: 0.75 });
          canvas.ds.computeVisibleArea?.();
        }
      }
      window.dispatchEvent(new Event('resize'));
      canvas.draw?.(true, true);
      canvas.setDirty?.(true, true);
    };
    const mountResizeObserver = (comfyApp) => {
      const target = document.querySelector('#graph-canvas-container,.graph-canvas-container');
      if (!target || !window.ResizeObserver || target.__h3ResizeObserver) return;
      const observer = new ResizeObserver(() => requestAnimationFrame(() => fitCanvas(comfyApp.canvas, comfyApp)));
      observer.observe(target);
      target.__h3ResizeObserver = observer;
    };
    installChrome();
    window.__h3ApplyChrome = installChrome;
    if (!window.__h3CanvasOnlyObserver && window.MutationObserver) {
      window.__h3CanvasOnlyObserver = new MutationObserver(() => requestAnimationFrame(() => window.__h3ApplyChrome?.()));
      window.__h3CanvasOnlyObserver.observe(document.documentElement, { childList: true, subtree: true });
    }${loadBlock}
    return true;
  })(); true;`;
}

function App() {
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState(Array(9).fill(""));
  const [previews, setPreviews] = useState(Array(9).fill(""));
  const [dragging, setDragging] = useState(false);
  const [prompt, setPrompt] = useState("一只狗飞在天上，镜头缓慢推进，电影感光影，细节丰富。");
  const [status, setStatus] = useState("正在启动本地引擎...");
  const [engineReady, setEngineReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [selectedVideo, setSelectedVideo] = useState("");
  const [hoveredVideo, setHoveredVideo] = useState("");
  const [queuePage, setQueuePage] = useState(false);
  const [queueJobs, setQueueJobs] = useState([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [audioMuted, setAudioMuted] = useState(() => localStorage.getItem("minimax-h3-muted") !== "false");
  const [settings, setSettings] = useState({ resolution: "standard", duration: 5, aspectRatio: "1:1 (Square)" });
  const [profile, setProfile] = useState(readProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("minimax-h3-theme") || "light");
  const [appVersion, setAppVersion] = useState("1.0.0");
  const [updateState, setUpdateState] = useState({ checking: false, downloading: false, hasUpdate: false, latestVersion: "", message: "" });
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false);
  const [editorWorkflow, setEditorWorkflow] = useState("i2v");
  const [backendUrl, setBackendUrl] = useState("");
  const [workflowJson, setWorkflowJson] = useState("");
  const [workflowIsCustom, setWorkflowIsCustom] = useState(false);
  const [workflowEditorStatus, setWorkflowEditorStatus] = useState("");
  const [workflowEditorBusy, setWorkflowEditorBusy] = useState(false);
  const [workflowJsonCollapsed, setWorkflowJsonCollapsed] = useState(true);
  const [comfySession, setComfySession] = useState("");
  const profileRef = useRef(null);
  const comfyRef = useRef(null);
  const comfyReadyRef = useRef(false);
  const comfyLoadInProgress = useRef(false);
  const comfyWorkflowRef = useRef("");
  const comfyLoadTimer = useRef(null);
  const comfyLoadRequest = useRef(0);
  const loadGraphIntoComfyRef = useRef(null);
  const workflowLoadRequest = useRef(0);
  const current = workflows[selected];
  const selectedCount = files.filter(Boolean).length;
  const visibleMediaCount = current.media === 9 ? Math.min(9, Math.max(1, selectedCount + 1)) : current.media;
  const visibleHistory = history.filter((item) => item.workflow === current.id);
  const activeVideo = visibleHistory.find((item) => item.path === selectedVideo) || visibleHistory[0];
  const queueWaitingCount = queueJobs.filter((job) => ["queued", "preparing", "running"].includes(job.state)).length;
  const engineText = status === "正在启动本地引擎..." ? "Starting" : status.replace("本地引擎已就绪", "Ready");

  const refreshHistory = async (preferLatest = false) => {
    try {
      const items = await window.studio.listVideos();
      setHistory(items);
      setSelectedVideo((previous) => {
        if (!items.length) return "";
        if (preferLatest || !items.some((item) => item.path === previous)) return items[0].path;
        return previous;
      });
      return items;
    } catch (_) {
      return [];
    }
  };

  const deleteVideo = async (item, event) => {
    event.stopPropagation();
    const result = await window.studio.deleteVideo(item.path);
    if (result?.ok) await refreshHistory();
  };

  const clearHistory = async () => {
    const result = await window.studio.clearVideos(current.id);
    if (result?.ok) {
      setSelectedVideo("");
      await refreshHistory();
    }
  };

  useEffect(() => {
    if (!window.studio) {
      setStatus("桌面接口未连接");
      return undefined;
    }
    const handleStatus = (value) => {
      setStatus(value);
      if (String(value).includes("本地引擎已就绪")) setEngineReady(true);
      if (String(value).includes("已停止") || String(value).includes("启动超时") || String(value).includes("便携包不完整")) setEngineReady(false);
    };
    const removeStatus = window.studio.onStatus(handleStatus);
    const handleProgress = (value) => {
      if (value?.jobId) setQueueJobs((old) => old.map((job) => job.id === value.jobId ? { ...job, progress: value, state: job.state === "preparing" ? "running" : job.state } : job));
    };
    const removeProgress = window.studio.onProgress(handleProgress);
    const removeQueue = window.studio.onQueueUpdated((items) => setQueueJobs(Array.isArray(items) ? items : []));
    const removeQueueControl = window.studio.onQueueControl((value) => setQueuePaused(Boolean(value?.paused)));
    const removeQueueCompleted = window.studio.onQueueCompleted(() => { refreshHistory(true); setStatus("生成完成"); });
    const removeQueueFailed = window.studio.onQueueFailed((job) => setStatus(`生成失败：${job?.error || "请查看队列详情"}`));
    window.studio.getAppVersion().then(setAppVersion).catch(() => {});
    window.studio.getBackendUrl().then((url) => { if (url) setEngineReady(true); }).catch(() => {});
    refreshHistory();
    window.studio.listQueue().then((items) => setQueueJobs(Array.isArray(items) ? items : [])).catch(() => {});
    window.studio.isQueuePaused().then((paused) => setQueuePaused(Boolean(paused))).catch(() => {});
    window.studio.setAudioMuted(audioMuted).catch(() => {});
    return () => { removeStatus?.(); removeProgress?.(); removeQueue?.(); removeQueueControl?.(); removeQueueCompleted?.(); removeQueueFailed?.(); };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem("minimax-h3-muted", String(audioMuted));
    window.studio?.setAudioMuted(audioMuted).catch(() => {});
  }, [audioMuted]);

  useEffect(() => {
    if (!workflowEditorOpen || backendUrl) return undefined;
    let cancelled = false;
    const poll = async () => {
      const url = await window.studio.getBackendUrl().catch(() => "");
      if (!cancelled && url) setBackendUrl(url);
    };
    poll();
    const timer = window.setInterval(poll, 1200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [workflowEditorOpen, backendUrl]);

  useEffect(() => {
    localStorage.setItem("minimax-h3-profile", JSON.stringify(profile));
  }, [profile]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("minimax-h3-theme", theme);
  }, [theme]);

  useEffect(() => {
    const timers = new Map();
    const markScrolling = (target) => {
      const element = target === window || target === document
        ? (document.scrollingElement || document.documentElement)
        : target && target.nodeType === 1 ? target : null;
      if (!element?.classList) return;
      element.classList.add("is-scrolling");
      const previous = timers.get(element);
      if (previous) window.clearTimeout(previous);
      const timer = window.setTimeout(() => {
        element.classList.remove("is-scrolling");
        timers.delete(element);
      }, 680);
      timers.set(element, timer);
    };
    const onScroll = (event) => markScrolling(event.target);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("scroll", onScroll);
      timers.forEach((timer, element) => {
        window.clearTimeout(timer);
        element.classList.remove("is-scrolling");
      });
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const close = (event) => {
      if (profileRef.current && !profileRef.current.contains(event.target)) setProfileOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const addPaths = async (paths, startIndex = files.findIndex((file) => !file)) => {
    const clean = paths.filter((file) => file && imageExtensions.test(file));
    if (!clean.length) return;
    const first = startIndex < 0 ? files.length : startIndex;
    const nextFiles = [...files];
    const nextPreviews = [...previews];
    const accepted = clean.slice(0, Math.max(0, current.media - first));
    for (let offset = 0; offset < accepted.length; offset += 1) {
      const index = first + offset;
      nextFiles[index] = accepted[offset];
      nextPreviews[index] = await window.studio.fileUrl(accepted[offset]);
    }
    setFiles(nextFiles);
    setPreviews(nextPreviews);
    if (clean.length > accepted.length) setStatus(`最多支持 ${current.media} 张参考图`);
  };

  const choose = async (index) => {
    const paths = await window.studio.pickFiles("image");
    if (paths?.length) await addPaths(paths, index);
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    setDragging(false);
    if (running) return;
    const paths = Array.from(event.dataTransfer.files || []).map((file) => file.path || "");
    await addPaths(paths);
  };

  const clearImage = (index, event) => {
    event.stopPropagation();
    const nextFiles = [...files];
    const nextPreviews = [...previews];
    nextFiles[index] = "";
    nextPreviews[index] = "";
    for (let i = index; i < nextFiles.length - 1; i += 1) {
      nextFiles[i] = nextFiles[i + 1];
      nextPreviews[i] = nextPreviews[i + 1];
    }
    nextFiles[nextFiles.length - 1] = "";
    nextPreviews[nextPreviews.length - 1] = "";
    setFiles(nextFiles);
    setPreviews(nextPreviews);
  };

  const chooseAvatar = async () => {
    const file = await window.studio.pickFile("image");
    if (!file) return;
    const avatar = await window.studio.fileUrl(file);
    if (avatar) setProfile((old) => ({ ...old, avatar }));
  };

  const checkUpdates = async () => {
    setUpdateState((old) => ({ ...old, checking: true, message: "正在检查..." }));
    const result = await window.studio.checkForUpdates();
    if (!result?.ok) return setUpdateState({ checking: false, downloading: false, hasUpdate: false, latestVersion: "", message: result?.error || "检查更新失败" });
    if (result.unsupported) return setUpdateState({ checking: false, downloading: false, hasUpdate: false, latestVersion: "", message: "当前平台暂不支持在线更新" });
    setUpdateState({ checking: false, downloading: false, hasUpdate: result.hasUpdate, latestVersion: result.latestVersion, message: result.hasUpdate ? `发现 v${result.latestVersion}` : `当前已是最新版本 v${result.currentVersion}` });
  };

  const applyUpdate = async () => {
    setUpdateState((old) => ({ ...old, downloading: true, message: "正在下载更新..." }));
    const result = await window.studio.updateApp();
    if (!result?.ok) setUpdateState((old) => ({ ...old, downloading: false, message: result?.error || "更新失败" }));
  };

  const loadEditorWorkflow = async (workflowId = editorWorkflow) => {
    const requestId = ++workflowLoadRequest.current;
    setWorkflowEditorBusy(true);
    setWorkflowEditorStatus("正在读取工作流...");
    try {
      const result = await window.studio.loadWorkflowConfig(workflowId);
      if (!result?.ok) throw new Error(result?.error || "读取失败");
      if (requestId !== workflowLoadRequest.current) return;
      setWorkflowJson(result.content || "");
      setWorkflowIsCustom(Boolean(result.custom));
      setWorkflowEditorStatus(result.custom ? "正在使用自定义工作流" : "正在使用默认工作流");
    } catch (error) {
      if (requestId !== workflowLoadRequest.current) return;
      setWorkflowEditorStatus(error.message);
    } finally {
      if (requestId === workflowLoadRequest.current) setWorkflowEditorBusy(false);
    }
  };

  const openWorkflowEditor = async () => {
    setProfileOpen(false);
    setWorkflowEditorOpen(true);
    setWorkflowJsonCollapsed(true);
    comfyReadyRef.current = false;
    setComfySession(`h3-${Date.now()}`);
    const url = await window.studio.getBackendUrl().catch(() => "");
    setBackendUrl(url || "");
    await loadEditorWorkflow(editorWorkflow);
  };

  const switchEditorWorkflow = async (workflowId) => {
    if (workflowId === editorWorkflow) return;
    comfyWorkflowRef.current = "";
    comfyLoadInProgress.current = false;
    setEditorWorkflow(workflowId);
    setWorkflowJson("");
    setWorkflowIsCustom(false);
    await loadEditorWorkflow(workflowId);
  };

  const importWorkflowJson = async () => {
    const result = await window.studio.pickWorkflowJson();
    if (result?.ok) {
      setWorkflowJson(result.content || "");
      setWorkflowIsCustom(false);
      setWorkflowEditorStatus(`已载入 ${result.name || "工作流"}，检查无误后点击应用`);
    }
  };
  const saveEditorWorkflow = async () => {
    setWorkflowEditorBusy(true);
    setWorkflowEditorStatus("正在保存...");
    const result = await window.studio.saveWorkflowConfig(editorWorkflow, workflowJson);
    setWorkflowEditorBusy(false);
    if (!result?.ok) return setWorkflowEditorStatus(result?.error || "保存失败");
    setWorkflowJson(result.content || workflowJson);
    setWorkflowIsCustom(true);
    setWorkflowEditorStatus("已应用到当前模式，下一次生成将使用此工作流");
  };

  const resetEditorWorkflow = async () => {
    setWorkflowEditorBusy(true);
    const result = await window.studio.resetWorkflowConfig(editorWorkflow);
    setWorkflowEditorBusy(false);
    if (!result?.ok) return setWorkflowEditorStatus(result?.error || "恢复失败");
    setWorkflowJson(result.content || "");
    setWorkflowIsCustom(false);
    setWorkflowEditorStatus("已恢复默认工作流");
  };

  const loadGraphIntoComfyLegacy = (workflowId = editorWorkflow, graphJson = workflowJson) => {
    if (!comfyRef.current || !graphJson.trim()) return;
    let graph;
    try { graph = JSON.parse(graphJson); } catch (_) { setWorkflowEditorStatus("工作流 JSON 格式不正确"); return; }
    const workflowKey = `${workflowId}:${graphJson.length}:${graphJson.slice(0, 48)}`;
    if (comfyWorkflowRef.current === workflowKey) return;
    comfyWorkflowRef.current = workflowKey;
    const requestId = ++comfyLoadRequest.current;
    comfyLoadInProgress.current = true;
    const payload = JSON.stringify(graph);
    const workflowName = JSON.stringify(workflows.find((item) => item.id === workflowId)?.name || workflowId);
    if (comfyLoadTimer.current) window.clearTimeout(comfyLoadTimer.current);
    comfyLoadTimer.current = window.setTimeout(() => {
      comfyLoadTimer.current = null;
      if (!comfyRef.current || !comfyReadyRef.current) { if (requestId === comfyLoadRequest.current) comfyLoadInProgress.current = false; return; }
      const script = `(() => { const requestId = ${requestId}; if (Number(window.__h3WorkflowRequest || 0) > requestId) return true; window.__h3WorkflowRequest = requestId; const apiGraph = ${payload}; const workflowName = ${workflowName}; let tries = 0; const normalizeChrome = () => { const style = document.getElementById('h3-workspace-style') || document.createElement('style'); style.id = 'h3-workspace-style'; style.textContent = '.comfyui-body{grid-template-columns:0 minmax(0,1fr) 0!important;grid-template-rows:0 minmax(0,1fr) 0!important}.comfyui-body-top,.comfyui-body-left{display:none!important}.graph-canvas-container{min-width:0!important}.comfyui-body-right,.comfyui-body-bottom{max-width:none!important}'; if (!style.parentNode) document.head.appendChild(style); const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node; while (node = walker.nextNode()) { if (node.nodeValue.trim() === 'Unsaved Workflow') node.nodeValue = '未命名工作流'; } }; const fitCanvas = (canvas, comfyApp) => { if (!canvas) return; normalizeChrome(); const root = document.querySelector('#vue-app'); const body = document.querySelector('.comfyui-body'); const graphContainer = document.querySelector('#graph-canvas-container, .graph-canvas-container'); const graphCanvas = comfyApp.canvasEl || document.querySelector('#graph-canvas'); document.documentElement.style.setProperty('width', '100%', 'important'); document.documentElement.style.setProperty('height', '100%', 'important'); document.documentElement.style.setProperty('overflow', 'hidden', 'important'); document.body.style.setProperty('width', '100%', 'important'); document.body.style.setProperty('height', '100%', 'important'); document.body.style.setProperty('min-height', '100%', 'important'); document.body.style.setProperty('overflow', 'hidden', 'important'); [root, body, graphContainer, graphCanvas].forEach((el) => { if (!el) return; el.style.setProperty('width', '100%', 'important'); el.style.setProperty('height', '100%', 'important'); el.style.setProperty('min-height', '0', 'important'); }); if (body) { body.style.setProperty('display', 'grid', 'important'); body.style.setProperty('grid-template-rows', '0 minmax(0,1fr) 0', 'important'); body.style.setProperty('grid-template-columns', '0 minmax(0,1fr) 0', 'important'); } let parent = graphContainer?.parentElement; while (parent && parent !== document.body) { parent.style.setProperty('min-height', '0', 'important'); if (parent !== root) parent.style.setProperty('height', '100%', 'important'); parent = parent.parentElement; } const bounds = graphContainer?.getBoundingClientRect(); if (graphCanvas && bounds?.width > 0 && bounds?.height > 0) { graphCanvas.style.setProperty('width', '100%', 'important'); graphCanvas.style.setProperty('height', '100%', 'important'); comfyApp.resizeCanvas?.(graphCanvas); } window.dispatchEvent(new Event('resize')); canvas.resize?.(); const nodes = canvas.graph?._nodes || comfyApp.rootGraph?._nodes || []; if (canvas.ds && nodes.length) { const rect = nodes.reduce((out, node) => { const x = Number(node.pos?.[0] || 0); const y = Number(node.pos?.[1] || 0); const w = Number(node.size?.[0] || 240); const h = Number(node.size?.[1] || 120); out[0] = Math.min(out[0], x); out[1] = Math.min(out[1], y); out[2] = Math.max(out[2], x + w); out[3] = Math.max(out[3], y + h); return out; }, [Infinity, Infinity, -Infinity, -Infinity]); if (rect.every(Number.isFinite)) { canvas.ds.fitToBounds([rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]], { zoom: 0.75 }); canvas.ds.computeVisibleArea?.(); } } canvas.draw?.(true, true); canvas.setDirty?.(true, true); }; const mountObserver = (comfyApp) => { const target = document.querySelector('#graph-canvas-container, .graph-canvas-container') || document.body; if (window.ResizeObserver && !target.__h3ResizeObserver) { const observer = new ResizeObserver(() => requestAnimationFrame(() => fitCanvas(comfyApp.canvas, comfyApp))); observer.observe(target); target.__h3ResizeObserver = observer; } }; const timer = setInterval(() => { if (Number(window.__h3WorkflowRequest || 0) !== requestId) { clearInterval(timer); return; } const comfyApp = window.comfyAPI?.app?.app || window.app; if (!comfyApp?.loadApiJson) { if (++tries > 60) clearInterval(timer); return; } clearInterval(timer); window.__h3Fit = () => fitCanvas(comfyApp.canvas, comfyApp); Promise.resolve(comfyApp.loadApiJson(apiGraph, 'h3-studio-workflow')).then(() => { if (Number(window.__h3WorkflowRequest || 0) !== requestId) return; try { window.__h3Baseline = JSON.stringify(comfyApp.rootGraph?.serialize?.() || {}); } catch (_) { window.__h3Baseline = ''; } let fits = 0; const fitTimer = setInterval(() => { if (Number(window.__h3WorkflowRequest || 0) !== requestId) { clearInterval(fitTimer); return; } fitCanvas(comfyApp.canvas, comfyApp); if (++fits >= 12) { clearInterval(fitTimer); mountObserver(comfyApp); } }, 700); requestAnimationFrame(() => fitCanvas(comfyApp.canvas, comfyApp)); }).catch(() => {}); }, 200); })(); true;`;
      comfyRef.current?.executeJavaScript(script).catch(() => {});
      window.setTimeout(() => { if (requestId === comfyLoadRequest.current) comfyLoadInProgress.current = false; }, 14000);
    }, 500);
  };

  const loadGraphIntoComfy = (workflowId = editorWorkflow, graphJson = workflowJson) => {
    if (!comfyRef.current || !graphJson.trim()) return;
    let graph;
    try { graph = JSON.parse(graphJson); } catch (_) { setWorkflowEditorStatus("工作流 JSON 格式不正确"); return; }
    const workflowKey = `${workflowId}:${graphJson.length}:${graphJson.slice(0, 48)}`;
    if (comfyWorkflowRef.current === workflowKey) return;
    comfyWorkflowRef.current = workflowKey;
    const requestId = ++comfyLoadRequest.current;
    comfyLoadInProgress.current = true;
    if (comfyLoadTimer.current) window.clearTimeout(comfyLoadTimer.current);
    comfyLoadTimer.current = window.setTimeout(() => {
      comfyLoadTimer.current = null;
      if (requestId !== comfyLoadRequest.current || !comfyRef.current || !comfyReadyRef.current) {
        if (requestId === comfyLoadRequest.current) comfyLoadInProgress.current = false;
        return;
      }
      const workflowName = workflows.find((item) => item.id === workflowId)?.name || workflowId;
      const script = createComfyGuestScript(graph, workflowName, requestId, true);
      comfyRef.current.executeJavaScript(script).catch(() => {});
      window.setTimeout(() => {
        if (requestId === comfyLoadRequest.current) comfyLoadInProgress.current = false;
      }, 14000);
    }, 120);
  };
  loadGraphIntoComfyRef.current = loadGraphIntoComfy;

  useEffect(() => {
    if (!workflowEditorOpen || !backendUrl || !comfyRef.current || !comfyReadyRef.current) return;
    const timer = window.setTimeout(() => comfyRef.current?.executeJavaScript("document.documentElement.style.height='100%'; document.body.style.height='100%'; document.querySelectorAll('#vue-app, #graph-canvas-container, #graph-canvas').forEach((el)=>el.style.height='100%'); window.dispatchEvent(new Event('resize')); true;").catch(() => {}), 120);
    return () => window.clearTimeout(timer);
  }, [workflowJsonCollapsed, workflowEditorOpen, backendUrl]);

  useEffect(() => {
    if (!workflowEditorOpen || !backendUrl || !comfyRef.current) return undefined;
    const view = comfyRef.current;
    const wrap = view.parentElement;
    if (!wrap) return undefined;
    const syncGuestSize = () => {
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      view.style.setProperty("width", `${Math.round(rect.width)}px`, "important");
      view.style.setProperty("height", `${Math.round(rect.height)}px`, "important");
      if (comfyReadyRef.current) view.executeJavaScript("window.dispatchEvent(new Event('resize')); true;").catch(() => {});
    };
    syncGuestSize();
    const observer = window.ResizeObserver ? new ResizeObserver(syncGuestSize) : null;
    observer?.observe(wrap);
    window.addEventListener("resize", syncGuestSize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", syncGuestSize); };
  }, [workflowEditorOpen, backendUrl, workflowJsonCollapsed]);

  useEffect(() => {
    const view = comfyRef.current;
    if (!workflowEditorOpen || !backendUrl || !view) return undefined;
    let readyHandled = false;
    comfyWorkflowRef.current = "";
    comfyLoadInProgress.current = false;
    const onReady = () => {
      if (readyHandled) return;
      readyHandled = true;
      if (!document.body.contains(view)) return;
      comfyReadyRef.current = true;
      view.executeJavaScript(createComfyGuestScript(null, "", 0, false)).catch(() => {});
      window.setTimeout(() => { if (comfyReadyRef.current) loadGraphIntoComfyRef.current?.(); }, 80);
    };
    const readyProbe = window.setInterval(() => {
      if (readyHandled) { window.clearInterval(readyProbe); return; }
      // executeJavaScript can reject while the webview is still on about:blank.
      // Wait until Chromium reports a real loaded document before injecting.
      if (view.isLoading || !view.getURL?.() || view.getURL() === "about:blank") return;
      onReady();
    }, 250);
    view.addEventListener("dom-ready", onReady);
    view.addEventListener("did-finish-load", onReady);
    return () => { window.clearInterval(readyProbe); view.removeEventListener("dom-ready", onReady); view.removeEventListener("did-finish-load", onReady); if (comfyLoadTimer.current) window.clearTimeout(comfyLoadTimer.current); comfyLoadTimer.current = null; comfyReadyRef.current = false; };
  }, [workflowEditorOpen, backendUrl, comfySession]);

  useEffect(() => {
    if (!workflowEditorOpen || !backendUrl || !workflowJson.trim()) return undefined;
    const timer = window.setTimeout(() => {
      if (comfyReadyRef.current) loadGraphIntoComfyRef.current?.(editorWorkflow, workflowJson);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [workflowEditorOpen, backendUrl, editorWorkflow, workflowJson]);

  const selectWorkflow = (index) => {
    setQueuePage(false);
    setSelected(index);
    setFiles(Array(9).fill(""));
    setPreviews(Array(9).fill(""));
    setSettings({ resolution: "standard", duration: 5, aspectRatio: index === 0 ? "1:1 (Square)" : "16:9 (Widescreen)" });
    if (index === 2) setPrompt("一只狗飞在天上，镜头缓慢推进，电影感光影，细节丰富。");
    else if (index === 0) setPrompt("Editorial product film, slow camera push-in, dramatic blue and amber rim light, detailed materials, cinematic sound design.");
    else setPrompt("Bold comic-book ink style, heavy linework, night city, dynamic camera movement and expressive character performance.");
  };

  const refreshQueue = async () => {
    try {
      const items = await window.studio.listQueue();
      setQueueJobs(Array.isArray(items) ? items : []);
      return items;
    } catch (_) {
      return [];
    }
  };

  const cancelQueueItem = async (jobId) => { await window.studio.cancelQueueItem(jobId); await refreshQueue(); };
  const removeQueueItem = async (jobId) => { await window.studio.removeQueueItem(jobId); await refreshQueue(); };
  const retryQueueItem = async (jobId) => { await window.studio.retryQueueItem(jobId); await refreshQueue(); };
  const toggleQueue = async () => {
    const result = queuePaused ? await window.studio.resumeQueue() : await window.studio.pauseQueue();
    if (!result?.ok) return setStatus(result?.error || "队列状态保存失败");
    setQueuePaused(Boolean(result.paused));
    await refreshQueue();
  };
  const clearQueue = async () => { await window.studio.clearQueue("finished"); await refreshQueue(); };

  const run = async () => {
    if (!engineReady) return setStatus("本地引擎未就绪，请稍后重试");
    if (current.media && !files[0]) return setStatus("请先选择参考素材");
    const selectedFiles = files.slice(0, current.media);
    const firstEmpty = selectedFiles.findIndex((file) => !file);
    if (firstEmpty >= 0 && selectedFiles.slice(firstEmpty + 1).some(Boolean)) return setStatus("请按顺序添加参考图");
    setRunning(true);
    try {
      const result = await window.studio.enqueue({ workflow: current.file, prompt, media: selectedFiles.filter(Boolean), settings });
      if (!result?.ok) throw new Error(result?.error || "加入队列失败");
      await refreshQueue();
      setStatus(result.position > 1 ? `已加入队列，第 ${result.position} 位` : "已加入队列，准备生成");
    } catch (error) {
      setStatus(`加入队列失败：${error.message}`);
    } finally {
      setRunning(false);
    }
  };

  return <div className="app-shell">
    <main className="workspace">
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="brand-mark">H3</span><span>Studio</span></div>
        <div className="section-label">创作</div>
        <nav>
          {workflows.map((item, index) => <button className={`workflow-card ${!queuePage && selected === index ? "active" : ""}`} key={item.id} onClick={() => selectWorkflow(index)}><span className="workflow-icon">{item.icon}</span><span>{item.name}</span><span className="chevron">›</span></button>)}
          <button className={`workflow-card queue-link ${queuePage ? "active" : ""}`} onClick={() => setQueuePage(true)}><span className="workflow-icon">≡</span><span>视频队列</span>{queueWaitingCount > 0 && <b className="queue-count">{queueWaitingCount}</b>}</button>
        </nav>
        <div className="sidebar-footer"><i className="dot" /><span>Local Engine</span><small>CUDA Ready</small></div>
      </aside>
      <section className="content">
        <header className="page-header">
          <div className="content-heading"><h1>{queuePage ? "视频队列" : current.name}</h1><p>{queuePage ? "按顺序管理本地视频生成任务" : current.id === "t2v" ? "将你的想法变成视频" : current.id === "i2v" ? "让静态画面拥有镜头运动" : "用参考图保持角色与风格一致"}</p></div>
          <div className="page-tools">
            <span className="engine-status"><i className="dot" /> Local · {engineText}</span>
            <button className="icon-button" title="打开输出目录" onClick={() => window.studio.openOutput()}>↗</button>
            <button className="icon-button audio-toggle" title={audioMuted ? "开启声音" : "关闭声音"} aria-label={audioMuted ? "开启声音" : "关闭声音"} onClick={() => setAudioMuted((muted) => !muted)}>{audioMuted ? "🔇" : "🔊"}</button>
            <div className="profile-anchor" ref={profileRef}><button className="profile-trigger" title="账户设置" onClick={() => setProfileOpen((open) => !open)}><span className="avatar avatar-small">{profile.avatar ? <img src={profile.avatar} alt="" /> : profile.name.slice(0, 1)}</span><span className="profile-name">{profile.name}</span><span className="profile-caret">⌄</span></button>{profileOpen && <div className="profile-menu"><div className="menu-heading"><span>账户设置</span><button className="menu-close" onClick={() => setProfileOpen(false)}>×</button></div><div className="profile-editor"><span className="avatar avatar-large">{profile.avatar ? <img src={profile.avatar} alt="" /> : profile.name.slice(0, 1)}</span><button className="avatar-change" onClick={chooseAvatar}>更换头像</button></div><label className="menu-label">用户名<input value={profile.name} maxLength={24} onChange={(event) => setProfile((old) => ({ ...old, name: event.target.value }))} /></label><div className="theme-row"><span>界面主题</span><div className="theme-switch"><button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>深色</button><button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>浅色</button></div></div><div className="update-row"><span>版本更新<small>v{appVersion}</small></span><button disabled={updateState.checking || updateState.downloading} onClick={updateState.hasUpdate ? applyUpdate : checkUpdates}>{updateState.downloading ? "下载中..." : updateState.hasUpdate ? `更新到 v${updateState.latestVersion}` : "检查更新"}</button></div>{updateState.message && <div className={`update-message ${updateState.hasUpdate ? "available" : ""}`}>{updateState.message}</div>}<button className="workflow-settings-button" onClick={openWorkflowEditor}>高级工作流<span>配置 ComfyUI 节点与参数</span></button></div>}</div>
          </div>
        </header>
        {queuePage ? (
          <section className="queue-page">
            <div className="queue-toolbar">
              <div><strong>{queueJobs.filter((job) => !["completed", "failed", "cancelled"].includes(job.state)).length} 个待处理</strong><span>{queuePaused ? "已暂停，当前任务完成后停止后续任务" : "本地引擎按顺序执行"}</span></div>
              <div><button className="ghost-button" onClick={toggleQueue}>{queuePaused ? "继续队列" : "暂停队列"}</button><button className="clear-button" onClick={clearQueue}>清理已完成</button></div>
            </div>
            {queueJobs.length ? (
              <div className="queue-list">
                {queueJobs.map((job, index) => {
                  const jobPercent = Math.max(0, Math.min(100, Math.round((Number(job.progress?.value) || 0) / Math.max(1, Number(job.progress?.max) || 100) * 100)));
                  const mediaPreviews = Array.isArray(job.mediaPreviews) ? job.mediaPreviews : [];
                  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(job.state);
                  const elapsedEnd = terminal ? Number(job.completedAt || 0) : clock;
                  const elapsed = job.startedAt && elapsedEnd >= job.startedAt ? formatDuration(elapsedEnd - job.startedAt) : "";
                  const nodeStep = Number(job.progress?.nodeStep);
                  const nodeTotal = Number(job.progress?.nodeTotal);
                  return <article className={`queue-item queue-${job.state}`} key={job.id}>
                    <div className="queue-item-mark">{index + 1}</div>
                    <div className="queue-item-media">{mediaPreviews.length ? <>{mediaPreviews.slice(0, 3).map((url) => <img key={url} src={url} alt="" loading="lazy" />)}{mediaPreviews.length > 3 && <span>+{mediaPreviews.length - 3}</span>}</> : <span className="queue-item-media-placeholder">{job.mediaCount ? `${job.mediaCount} 张` : job.workflowName?.slice(0, 1) || "视频"}</span>}</div>
                    <div className="queue-item-main">
                      <div className="queue-item-head"><strong>{job.workflowName}</strong><span className="queue-state">{queueStateLabel(job.state)}</span></div>
                      <p>{job.prompt || "未填写 Prompt"}</p>
                      <small>{job.settings?.aspectRatio || "默认画幅"} · {job.settings?.resolution || "默认分辨率"} · {job.settings?.duration || 5} 秒 · {queueTime(job.createdAt)}</small>
                      {elapsed && <div className="queue-timing"><span>{terminal ? "生成用时" : "当前用时"} {elapsed}</span></div>}
                      {["preparing", "running"].includes(job.state) && <><div className="queue-step"><span>{job.progress?.label || "处理中"}</span>{Number.isFinite(nodeStep) && Number.isFinite(nodeTotal) && nodeTotal > 0 && <small>第 {Math.max(1, Math.min(nodeTotal, nodeStep || 1))}/{nodeTotal} 步</small>}</div><div className="queue-progress"><div><i style={{ width: `${jobPercent}%` }} /></div><b>{jobPercent}%</b></div></>}
                      {job.error && <div className="queue-error">{job.error}</div>}
                    </div>
                    <div className="queue-item-actions">{["queued", "preparing", "running"].includes(job.state) && <button className="queue-action danger" onClick={() => cancelQueueItem(job.id)}>{job.state === "running" ? "停止" : "取消"}</button>}{["failed", "cancelled", "interrupted"].includes(job.state) && <button className="queue-action" onClick={() => retryQueueItem(job.id)}>重试</button>}{job.state === "completed" && job.outputPath && <button className="queue-action" onClick={() => window.studio.openVideo(job.outputPath)}>打开视频</button>}{terminal && <button className="queue-action subtle" onClick={() => removeQueueItem(job.id)}>移除</button>}</div>
                  </article>;
                })}
              </div>
            ) : <div className="queue-empty"><strong>队列为空</strong><span>在任意创作页面点击“开始生成”，任务会出现在这里。</span></div>}
          </section>
        ) : <>
          <div className={`creation-grid ${current.media ? "with-media" : "no-media"}`}>
            {current.media > 0 && <section className="media-section"><div className="section-heading"><span>参考图片</span><em>{selectedCount} / {current.media}</em></div><div className={`media-grid ${dragging ? "is-dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={handleDrop}>{Array.from({ length: visibleMediaCount }).map((_, i) => <button className={`dropzone ${files[i] ? "has-file" : ""}`} disabled={running} key={i} onClick={() => choose(i)}>{files[i] ? <><img className="preview-image" src={previews[i]} alt="" /><span className="preview-overlay"><b>{files[i].split(/[\\/]/).pop()}</b><small>点击替换</small></span><span className="clear-image" title="移除图片" onClick={(event) => clearImage(i, event)}>×</span></> : <><span className="upload-symbol">+</span><b>{i === 0 ? "添加参考图片" : "继续添加"}</b><small>PNG / JPG / WEBP</small></>}</button>)}</div></section>}
            <section className="composer"><div className="composer-label"><span>Prompt</span><em>{prompt.length} / 2000</em></div><textarea value={prompt} maxLength={2000} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想生成的视频画面、镜头和声音..." /><div className="composer-bar"><div className="generation-controls"><label>画幅<select value={settings.aspectRatio} onChange={(e) => setSettings((old) => ({ ...old, aspectRatio: e.target.value }))}><option value="16:9 (Widescreen)">16:9</option><option value="1:1 (Square)">1:1</option><option value="9:16 (Portrait Widescreen)">9:16</option></select></label><label>分辨率<select value={settings.resolution} onChange={(e) => setSettings((old) => ({ ...old, resolution: e.target.value }))}><option value="standard">标准</option><option value="hd">高清</option><option value="ultra">超清</option></select></label><label>时长<select value={settings.duration} onChange={(e) => setSettings((old) => ({ ...old, duration: Number(e.target.value) }))}><option value="5">5 秒</option><option value="8">8 秒</option><option value="10">10 秒</option></select></label></div><button className="run-button" disabled={running || !engineReady} onClick={run}>{running ? "加入中..." : "加入队列  →"}</button></div></section>
          </div>
          <section className="results-section"><div className="section-heading"><span>最近生成</span><div className="results-tools"><em>{visibleHistory.length ? `${visibleHistory.length} 个视频` : ""}</em>{visibleHistory.length > 0 && <button className="clear-button" onClick={clearHistory}>清空</button>}<button className="refresh-button" onClick={() => refreshHistory()}>刷新</button></div></div>{visibleHistory.length ? <div className="gallery">{visibleHistory.map((item) => <article className={`video-card ${activeVideo?.path === item.path ? "selected" : ""}`} key={item.path} onClick={() => setSelectedVideo(item.path)} onMouseEnter={(event) => { setHoveredVideo(item.path); const video = event.currentTarget.querySelector("video"); video?.play().catch(() => {}); }} onMouseLeave={(event) => { setHoveredVideo(""); const video = event.currentTarget.querySelector("video"); if (video) { video.pause(); video.currentTime = 0; } }}><div className="video-thumb"><video src={item.url} muted={audioMuted} playsInline preload="metadata" /><button className="delete-video" title="删除视频" aria-label="删除视频" onClick={(event) => deleteVideo(item, event)}>×</button></div><div className="video-card-copy"><strong>{item.name}</strong><small>{formatDate(item.modified)} · {formatSize(item.size)}</small></div></article>)}</div> : <div className="recent-empty">暂无生成记录</div>}</section>
        </>}
      </section>
    </main>
    {workflowEditorOpen && <div className="workflow-modal-backdrop" role="dialog" aria-modal="true"><section className="workflow-modal"><header className="workflow-modal-header"><div><h2>高级工作流</h2><p>在 ComfyUI 中调整节点，保存后应用到当前模式</p></div><button className="menu-close" onClick={() => setWorkflowEditorOpen(false)} aria-label="关闭">×</button></header><div className="workflow-modal-body"><aside className="workflow-editor-nav"><span>工作流</span>{workflows.map((item) => <button key={item.id} className={editorWorkflow === item.id ? "active" : ""} onClick={() => switchEditorWorkflow(item.id)}>{item.icon}<span>{item.name}</span>{editorWorkflow === item.id && workflowIsCustom && <i>已改</i>}</button>)}</aside><div className={`workflow-editor-main ${workflowJsonCollapsed ? "json-collapsed" : ""}`}><div className="comfy-frame-wrap">{backendUrl ? <webview key={comfySession} partition={comfySession} ref={comfyRef} title="ComfyUI 工作流编辑器" src={backendUrl} /> : <div className="comfy-unavailable">本地引擎尚未就绪，请稍后重试</div>}</div><div className="workflow-json-panel"><div className="workflow-json-head"><span>API 工作流 JSON</span><div><button onClick={() => setWorkflowJsonCollapsed((collapsed) => !collapsed)}>{workflowJsonCollapsed ? "展开" : "收起"}</button><button onClick={importWorkflowJson} disabled={workflowEditorBusy}>导入 JSON</button></div></div>{!workflowJsonCollapsed && <><textarea value={workflowJson} onChange={(event) => { setWorkflowJson(event.target.value); setWorkflowIsCustom(false); }} spellCheck="false" placeholder="从 ComfyUI 使用“Save (API Format)”导出后导入" /><small>仅支持 ComfyUI API 格式；普通界面工作流 JSON 不能直接用于生成。</small></>}</div></div></div><footer className="workflow-modal-footer"><span className={workflowEditorStatus.includes("失败") || workflowEditorStatus.includes("不正确") ? "error" : ""}>{workflowEditorStatus}</span><div><button className="ghost-button" onClick={resetEditorWorkflow} disabled={workflowEditorBusy}>恢复默认</button><button className="primary-button" onClick={saveEditorWorkflow} disabled={workflowEditorBusy || !workflowJson.trim()}>应用到当前模式</button></div></footer></section></div>}
  </div>;
}

createRoot(document.getElementById("root")).render(<App />);
