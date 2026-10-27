import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import ReferencePromptEditor from "./ReferencePromptEditor.jsx";
import ReferenceAssetsPanel from "./ReferenceAssetsPanel.jsx";
import CutoutWorkspace from "./CutoutWorkspace.jsx";
import VoiceWorkspace from "./VoiceWorkspace.jsx";
import AiToolsWorkspace from "./AiToolsWorkspace.jsx";
import NavigationIcon from "./NavigationIcon.jsx";
import IntegrationSettings from "./IntegrationSettings.jsx";
import { aiTools } from "./aiTools.mjs";
import GenerationInputs from "./GenerationInputs.jsx";
import VideoThumbnail from "./VideoThumbnail.jsx";
import generationProfiles from "../generation-profiles.json";
import { normalizeStudioConfig } from "./studioConfig.mjs";
import { assetDisplayName, parseReferencePrompt, promptPartsToText } from "./referencePromptParser.mjs";

const workflows = [
  { id: "i2v", name: "图生视频", file: "MiniMax-H3-图生视频.json", media: 2, icon: "◩" },
  { id: "r2v", name: "参考生视频", file: "MiniMax-H3-参考生视频.json", media: 9, icon: "◈" },
  { id: "t2v", name: "文生视频", file: "MiniMax-H3-文生视频.json", media: 0, icon: "✦" },
  { id: "cutout", name: "批量自动抠图", file: "InspyrenetRembg抠图.json", media: 1, icon: "◌" },
  { id: "continuation", name: "视频续接", file: "MiniMax-H3-视频续接.json", media: 1, icon: "▷", video: true, description: "提取上一段视频的尾帧，生成新的片段" },
  { id: "multiframe", name: "多帧参考", file: "MiniMax-H3-多帧参考.json", media: 4, icon: "▤", description: "在指定时间放置参考画面" },
  { id: "control", name: "控制视频", file: "MiniMax-H3-控制视频.json", media: 1, icon: "⌘", video: true, description: "使用姿态或控制画面引导生成" },
];

const imageExtensions = /\.(png|jpe?g|webp|avif)$/i;
const PROMPT_HISTORY_KEY = "minimax-h3-prompt-history-v1";
const PROMPT_PRESETS_KEY = "minimax-h3-prompt-presets-v1";
const ASSET_LIBRARY_KEY = "minimax-h3-asset-library-v1";
const VIDEO_FAVORITES_KEY = "minimax-h3-video-favorites-v1";
const NOTIFICATIONS_KEY = "minimax-h3-notifications-v1";
const WORKFLOW_DRAFTS_KEY = "minimax-h3-workflow-drafts-v1";
const CUTOUT_OPTIONS_KEY = "minimax-h3-cutout-options-v1";
const DEFAULT_SETTINGS = { resolution: "standard", duration: 5, aspectRatio: "1:1 (Square)", fps: 24, seedMode: "random", seed: "", batchCount: 1, negativePrompt: "", samplingMode: "quality", style: "", frameTimes: [0, 1.5, 3, 4.5], controlMode: "pose", controlStrength: 1 };
const DEFAULT_PROMPT_PRESETS = [
  { id: "default-cinematic", text: "电影感镜头，光影自然，动作连贯", createdAt: 0 },
  { id: "default-consistency", text: "保持主体外观一致，细节稳定", createdAt: 0 },
  { id: "default-motion", text: "镜头缓慢推进，画面稳定，运动平滑", createdAt: 0 },
];

function persistValue(key, value) {
  localStorage.setItem(key, value);
  window.studio?.savePreference?.(key, value).then((result) => {
    if (result?.ok === false) window.dispatchEvent(new CustomEvent("h3-preference-error", { detail: result.error }));
  }).catch((error) => window.dispatchEvent(new CustomEvent("h3-preference-error", { detail: error.message })));
}

function newAssetId() {
  return globalThis.crypto?.randomUUID?.() || `asset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomSeed() {
  return Math.floor(Math.random() * 900000000000000) + 100000000000000;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function readDroppedFileEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDroppedDirectoryEntry(entry) {
  const reader = entry.createReader();
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    entries.push(...batch);
  }
  const files = [];
  for (const child of entries) {
    if (child.isDirectory) files.push(...await readDroppedDirectoryEntry(child));
    else if (child.isFile) files.push(await readDroppedFileEntry(child));
  }
  return files;
}

async function collectDroppedFiles(event) {
  const items = Array.from(event.dataTransfer?.items || []);
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(event.dataTransfer?.files || []);
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory) files.push(...await readDroppedDirectoryEntry(entry));
    else if (entry.isFile) {
      try { files.push(await readDroppedFileEntry(entry)); } catch (_) {}
    }
  }
  return files;
}

function readProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem("minimax-h3-profile") || "{}");
    return { name: saved.name || "创作者", avatar: saved.avatar || "" };
  } catch (_) {
    return { name: "创作者", avatar: "" };
  }
}

function readPromptHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).map(([workflowId, entries]) => [workflowId, (Array.isArray(entries) ? entries : []).map((entry, index) => {
      if (typeof entry === "string") return { id: `${workflowId}-${index}-${entry.slice(0, 12)}`, text: entry, createdAt: 0 };
      return {
        id: String(entry?.id || `${workflowId}-${index}`),
        text: String(entry?.text || ""),
        parts: Array.isArray(entry?.parts) ? entry.parts.map((part) => part?.type === "mention"
          ? { type: "mention", assetId: String(part.assetId || ""), label: String(part.label || "素材"), role: String(part.role || "") }
          : { type: "text", text: String(part?.text || "") }) : [],
        createdAt: Number(entry?.createdAt) || 0,
      };
    }).filter((entry) => entry.text.trim())]));
  } catch (_) {
    return {};
  }
}

function readPromptPresets() {
  try {
    const raw = localStorage.getItem(PROMPT_PRESETS_KEY);
    if (raw === null) return DEFAULT_PROMPT_PRESETS;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return DEFAULT_PROMPT_PRESETS;
    const seen = new Set();
    return saved.map((entry, index) => ({
      id: String(entry?.id || `preset-${index}-${Date.now()}`),
      text: String(typeof entry === "string" ? entry : entry?.text || "").replace(/\r\n?/g, "\n").trim(),
      createdAt: Number(entry?.createdAt) || 0,
    })).filter((entry) => {
      if (!entry.text || seen.has(entry.text)) return false;
      seen.add(entry.text);
      return true;
    }).slice(0, 50);
  } catch (_) {
    return DEFAULT_PROMPT_PRESETS;
  }
}

function readStoredArray(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const saved = JSON.parse(raw);
    return Array.isArray(saved) ? saved : fallback;
  } catch (_) {
    return fallback;
  }
}

function readStoredObject(key, fallback = {}) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const saved = JSON.parse(raw);
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : fallback;
  } catch (_) {
    return fallback;
  }
}

function queueStateLabel(state) {
  return { queued: "排队中", preparing: "准备中", running: "生成中", completed: "已完成", "output-missing": "结果已移除", failed: "生成失败", cancelled: "已取消", interrupted: "已中断" }[state] || state;
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

function progressPercent(progress) {
  const max = Math.max(1, Number(progress?.max) || 100);
  const value = Number(progress?.value) || 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function videoAspectClass(item) {
  if (Number(item?.width) > 0 && Number(item?.height) > 0) return videoAspectClass({ aspectRatio: `${item.width}:${item.height}` });
  const value = String(item?.aspectRatio || item?.resolution || "").toLowerCase();
  const ratio = value.match(/(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)/);
  if (ratio) {
    const width = Number(ratio[1]);
    const height = Number(ratio[2]);
    if (width > 0 && height > 0) {
      const valueRatio = width / height;
      if (valueRatio < 0.8) return "portrait";
      if (valueRatio > 1.2) return "landscape";
      return "square";
    }
  }
  if (value.includes("portrait") || value.includes("vertical") || value.includes("竖")) return "portrait";
  if (value.includes("square") || value.includes("正方")) return "square";
  return "landscape";
}

function resolutionDisplay(resolution, aspectRatio) {
  const key = String(resolution || "standard").toLowerCase();
  const aspect = videoAspectClass({ aspectRatio });
  const dimensions = generationProfiles[aspect]?.[key];
  return dimensions ? dimensions.join(" × ") : String(resolution || "默认分辨率");
}

function historyResolutionDisplay(item) {
  if (Number(item.width) > 0 && Number(item.height) > 0) return `${item.width} × ${item.height}`;
  return { standard: "标准", hd: "高清", ultra: "超清" }[item.resolution] || String(item.resolution || "");
}

function batchCountValue(value) {
  return Math.max(1, Math.min(8, Math.floor(Number(value) || 1)));
}

function syncVideoNativeAspect(event) {
  const video = event.currentTarget;
  const frame = video.closest(".video-thumb, .video-preview-player") || video.parentElement;
  if (!frame || !video.videoWidth || !video.videoHeight) return;
  frame.dataset.aspect = videoAspectClass({ aspectRatio: `${video.videoWidth}:${video.videoHeight}` });
  frame.dataset.nativeRatio = `${video.videoWidth}:${video.videoHeight}`;
}

function ProgressIndicator({ progress, className = "" }) {
  if (!progress) return null;
  const percent = progressPercent(progress);
  const detailStep = Number(progress.detailStep);
  const detailStepMax = Number(progress.detailStepMax);
  const hasDetailStep = Number.isFinite(detailStep) && Number.isFinite(detailStepMax) && detailStepMax > 0;
  // 节点总数是内部调试信息，对用户没有直接帮助；只显示当前采样步数。
  const stepText = hasDetailStep ? `采样 ${Math.max(0, Math.min(detailStepMax, detailStep || 0))}/${detailStepMax} 步` : "";
  return <div className={`progress-area ${className}`} aria-live="polite">
    <span className="progress-label">{progress.label || "处理中"}</span>
    <div className={`progress-track ${progress.indeterminate ? "indeterminate" : ""}`}><div style={{ width: `${percent}%` }} /></div>
    <b>{percent}%</b>
    {stepText && <small className="progress-step">{stepText}</small>}
  </div>;
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
       // ComfyUI exposes loadApiJson before every optional readiness helper.
       // Only wait for the API loader and canvas so older/newer ComfyUI builds both work.
       if (!comfyApp?.loadApiJson || !comfyApp?.canvas) return false;
         window.__h3Fit = () => fitCanvas(comfyApp.canvas, comfyApp);
         window.__h3WorkflowError = '';
         window.__h3WorkflowLoadedRequest = 0;
         Promise.resolve(comfyApp.loadApiJson(apiGraph, workflowPath)).then(() => {
           if (Number(window.__h3WorkflowRequest || 0) !== requestId) return;
           window.__h3WorkflowDisplayName = workflowName;
           applyWorkflowLabel();
          // Fit once after loading. Resize events must preserve the user's zoom/pan.
           fitCanvas(comfyApp.canvas, comfyApp, true);
           mountResizeObserver(comfyApp);
           requestAnimationFrame(() => fitCanvas(comfyApp.canvas, comfyApp));
           window.__h3WorkflowLoadedRequest = requestId;
         }).catch((error) => {
           window.__h3WorkflowError = error?.message || 'ComfyUI 工作流加载失败';
         });
      return true;
    };
     const loadTimer = setInterval(() => {
       if (load()) clearInterval(loadTimer);
       else if (++tries > 120) { window.__h3WorkflowError = 'ComfyUI 画布初始化超时'; clearInterval(loadTimer); }
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
    const applyExecutionNode = (nodeId) => {
      const normalized = nodeId === null || nodeId === undefined ? "" : String(nodeId);
      window.__h3ExecutionNodeId = normalized;
      document.querySelectorAll('[data-node-id].h3-execution-active').forEach((element) => element.classList.remove('h3-execution-active'));
      if (normalized) {
        const target = [...document.querySelectorAll('[data-node-id]')].find((element) => element.getAttribute('data-node-id') === normalized);
        target?.classList.add('h3-execution-active');
      }
      const comfyApp = window.comfyAPI?.app?.app || window.app;
      const canvas = comfyApp?.canvas;
      const nodes = canvas?.graph?._nodes || comfyApp?.rootGraph?._nodes || [];
      const node = nodes.find((item) => String(item.id) === normalized);
      if (canvas) {
        const previous = window.__h3ExecutionNodeObject;
        if (previous && previous !== node && previous.__h3OriginalStyle) {
          previous.color = previous.__h3OriginalStyle.color;
          previous.bgcolor = previous.__h3OriginalStyle.bgcolor;
          delete previous.__h3OriginalStyle;
        }
        if (node) {
          if (!node.__h3OriginalStyle) node.__h3OriginalStyle = { color: node.color, bgcolor: node.bgcolor };
          node.color = "#6366f1";
          node.bgcolor = "#27283d";
        }
        window.__h3ExecutionNodeObject = node || null;
        canvas.node_in_progress = node || null;
        canvas.node_in_progress_id = normalized;
        canvas.draw?.(true, true);
        canvas.setDirty?.(true, true);
      }
      return Boolean(node || normalized === "");
    };
    // Export the current canvas through ComfyUI's own graphToPrompt converter.
    // rootGraph.serialize() is the visual workflow format; graphToPrompt()
    // produces the API format that the backend and this app actually execute.
    window.__h3ExportApiGraph = async () => {
      const comfyApp = window.comfyAPI?.app?.app || window.app;
      if (!comfyApp?.rootGraph || typeof comfyApp.graphToPrompt !== 'function') throw new Error('ComfyUI 画布尚未就绪');
      const result = await comfyApp.graphToPrompt(comfyApp.rootGraph);
      if (!result?.output || typeof result.output !== 'object') throw new Error('无法读取当前工作流');
      return result.output;
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
        '[data-node-id].h3-execution-active{outline:3px solid #6366f1!important;outline-offset:4px!important;box-shadow:0 0 0 4px rgba(99,102,241,.16)!important;z-index:9999!important}',
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
      window.__h3SetExecutionNode = applyExecutionNode;
      applyExecutionNode(window.__h3ExecutionNodeId || "");
    };
    const fitCanvas = (canvas, comfyApp, fitView = false) => {
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
      if (fitView && canvas.ds && nodes.length) {
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
  const [preferenceError, setPreferenceError] = useState("");
  useEffect(() => {
    const onError = event => setPreferenceError(`配置保存失败：${event.detail || "请检查磁盘和文件权限"}`);
    window.addEventListener("h3-preference-error", onError);
    return () => window.removeEventListener("h3-preference-error", onError);
  }, []);
  const initialDraft = useRef(readStoredObject(WORKFLOW_DRAFTS_KEY).i2v || {}).current;
  const [selected, setSelected] = useState(0);
  // Keep enough slots for a cutout batch while video workflows still expose
  // only the slots their workflow supports.
  const [files, setFiles] = useState(() => [...(initialDraft.files || []), ...Array(50).fill("")].slice(0, 50));
  const [previews, setPreviews] = useState(() => [...(initialDraft.previews || []), ...Array(50).fill("")].slice(0, 50));
  const [selectedCutoutIndex, setSelectedCutoutIndex] = useState(-1);
  const [referenceAssets, setReferenceAssets] = useState([]);
  const [referenceImageLimit, setReferenceImageLimit] = useState(9);
  const [promptParts, setPromptParts] = useState([{ type: "text", text: "" }]);
  const [assetPreview, setAssetPreview] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [prompt, setPrompt] = useState(initialDraft.prompt || "");
  const [promptHistory, setPromptHistory] = useState(readPromptHistory);
  const [promptHistoryOpen, setPromptHistoryOpen] = useState(false);
  const [promptPresets, setPromptPresets] = useState(readPromptPresets);
  const [promptPresetEditor, setPromptPresetEditor] = useState(null);
  const [status, setStatus] = useState("正在启动本地引擎...");
  const [engineReady, setEngineReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [cutoutHistory, setCutoutHistory] = useState([]);
  const [cutoutRecentResults, setCutoutRecentResults] = useState([]);
  const [cutoutOptions, setCutoutOptions] = useState(() => ({ format: "png", filenamePrefix: "", preserveName: true, batchFolder: true, batchName: "" }));
  const [cutoutBatch, setCutoutBatch] = useState(null);
  const [selectedVideo, setSelectedVideo] = useState("");
  const [previewVideo, setPreviewVideo] = useState(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFavoritesOnly, setHistoryFavoritesOnly] = useState(false);
  const [queuePage, setQueuePage] = useState(false);
  const [voicePage, setVoicePage] = useState(false);
  const [aiToolsPage, setAiToolsPage] = useState(false);
  const [aiToolKind, setAiToolKind] = useState("enhance");
  const [queueJobs, setQueueJobs] = useState([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [queueDragId, setQueueDragId] = useState("");
  const [queueDetailJob, setQueueDetailJob] = useState(null);
  const [activeProgress, setActiveProgress] = useState(null);
  const [clock, setClock] = useState(() => Date.now());
  const [audioMuted, setAudioMuted] = useState(() => localStorage.getItem("minimax-h3-muted") !== "false");
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS, ...initialDraft.settings, fps: 24, batchCount: 1 });
  const [assetLibrary, setAssetLibrary] = useState(() => readStoredArray(ASSET_LIBRARY_KEY));
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [videoFavorites, setVideoFavorites] = useState(() => readStoredArray(VIDEO_FAVORITES_KEY).map(String));
  const [videoMenuPath, setVideoMenuPath] = useState("");
  const [healthOpen, setHealthOpen] = useState(false);
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [healthState, setHealthState] = useState({ loading: false, data: null, error: "" });
  const [storageOpen, setStorageOpen] = useState(false);
  const [storageState, setStorageState] = useState({ loading: false, data: null, error: "" });
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => localStorage.getItem(NOTIFICATIONS_KEY) !== "false");
  const [profile, setProfile] = useState(readProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("minimax-h3-theme") || "light");
  const [appVersion, setAppVersion] = useState("1.0.0");
  const [updateState, setUpdateState] = useState({ checking: false, downloading: false, hasUpdate: false, latestVersion: "", message: "", notes: "" });
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false);
  const [generationStyles, setGenerationStyles] = useState([]);
  useEffect(() => { window.studio?.getGenerationStyles?.().then(setGenerationStyles).catch(console.error); }, []);
  const [editorWorkflow, setEditorWorkflow] = useState("i2v");
  const [backendUrl, setBackendUrl] = useState("");
  const [workflowJson, setWorkflowJson] = useState("");
  const [workflowIsCustom, setWorkflowIsCustom] = useState(false);
  const [workflowEditorStatus, setWorkflowEditorStatus] = useState("");
  const [workflowEditorBusy, setWorkflowEditorBusy] = useState(false);
  const [workflowJsonCollapsed, setWorkflowJsonCollapsed] = useState(true);
  const [workflowBackups, setWorkflowBackups] = useState([]);
  // Keep one embedded ComfyUI session for the lifetime of the app. Switching
  // workflows replaces the graph inside this same webview instead of opening
  // another page or browser partition.
  const [comfySession] = useState(() => `h3-${Date.now()}`);
  const workflowDraftsRef = useRef(readStoredObject(WORKFLOW_DRAFTS_KEY));
  const profileRef = useRef(null);
  const runPendingRef = useRef(false);
  const comfyRef = useRef(null);
  const previewPlayerRef = useRef(null);
  const comfyReadyRef = useRef(false);
  const comfyLoadInProgress = useRef(false);
  const comfyWorkflowRef = useRef("");
  const comfyLoadTimer = useRef(null);
  const comfyLoadRequest = useRef(0);
  const latestProgressRef = useRef(null);
  const progressByJobRef = useRef(new Map());
  const progressClearTimerRef = useRef(null);
  const comfyExecutionNodeRef = useRef("");
  const loadGraphIntoComfyRef = useRef(null);
  const workflowLoadRequest = useRef(0);
  const current = workflows[selected];
  const selectedCount = files.filter(Boolean).length;
  const visibleMediaCount = current.media === 9 ? Math.min(9, Math.max(1, selectedCount + 1)) : current.media;
  const referencePrompt = parseReferencePrompt({ text: prompt, parts: promptParts }, referenceAssets);
  const historyItems = history
    .filter((item) => item.workflow === current.id)
    .map((item) => ({ ...item, favorite: videoFavorites.includes(item.path) || Boolean(item.favorite) }));
  const visibleHistory = historyItems.filter((item) => {
      const query = historyQuery.trim().toLowerCase();
      const matchesQuery = !query || [item.name, item.prompt, item.originalPrompt].some((value) => String(value || "").toLowerCase().includes(query));
      return matchesQuery && (!historyFavoritesOnly || item.favorite);
    });
  const historyGroups = [
    { key: "landscape", label: "横屏", ratio: "16:9", items: visibleHistory.filter((item) => videoAspectClass(item) === "landscape") },
    { key: "portrait", label: "竖屏", ratio: "9:16", items: visibleHistory.filter((item) => videoAspectClass(item) === "portrait") },
    { key: "square", label: "方形", ratio: "1:1", items: visibleHistory.filter((item) => videoAspectClass(item) === "square") },
  ].filter((group) => group.items.length);
  const activeVideo = visibleHistory.find((item) => item.path === selectedVideo) || visibleHistory[0];
  const currentPromptHistory = Array.isArray(promptHistory[current.id]) ? promptHistory[current.id] : [];
  const queueWaitingCount = queueJobs.filter((job) => ["queued", "preparing", "running"].includes(job.state)).length;
  const completedDurations = queueJobs.filter((job) => job.state === "completed").map((job) => Number(job.completedAt) - Number(job.startedAt)).filter((value) => Number.isFinite(value) && value > 0);
  const averageJobMs = completedDurations.length ? completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length : 0;
  const queueEtaText = !queuePaused && averageJobMs && queueWaitingCount > 0 ? `全部完成预计约 ${formatDuration(averageJobMs * queueWaitingCount)}` : "";
  const engineText = engineReady ? "就绪" : "启动中";
  const hardwareText = engineReady ? "引擎已连接" : "引擎未连接";

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
    } catch (error) {
      setStatus(error?.message || "读取视频历史失败");
      return [];
    }
  };

  const refreshCutouts = async () => {
    try {
      const items = await window.studio.listCutouts?.();
      setCutoutHistory(Array.isArray(items) ? items : []);
      return Array.isArray(items) ? items : [];
    } catch (error) {
      setStatus(error?.message || "读取抠图历史失败");
      return [];
    }
  };

  const syncComfyExecution = (progress) => {
    latestProgressRef.current = progress || null;
    const view = comfyRef.current;
    if (!view || !comfyReadyRef.current) return;
    const max = Number(progress?.max) || 100;
    const value = Number(progress?.value) || 0;
    const nodeId = value >= max || progress?.label === "完成" ? "" : String(progress?.nodeId || "");
    if (comfyExecutionNodeRef.current === nodeId) return;
    comfyExecutionNodeRef.current = nodeId;
    view.executeJavaScript(`window.__h3SetExecutionNode?.(${JSON.stringify(nodeId)}); true;`).catch(() => {});
  };

  const deleteVideo = async (item, event) => {
    event.stopPropagation();
    const result = await window.studio.deleteVideo(item.path);
    if (result?.ok || result?.deleted) {
      setVideoFavorites(old => old.filter(file => file !== item.path));
      await refreshHistory();
    }
    if (!result?.ok && !result?.canceled) setStatus(result?.error || "删除视频失败");
  };

  const clearHistory = async () => {
    const result = await window.studio.clearVideos(current.id);
    if (result?.ok || result?.count > 0) {
      setSelectedVideo("");
      await refreshHistory();
    }
    if (!result?.ok && !result?.canceled) setStatus(result?.error || "删除视频失败");
  };

  const toggleVideoFavorite = async (item, event) => {
    event?.stopPropagation();
    const favorite = !item.favorite;
    const result = await window.studio.setVideoFavorite?.(item.path, favorite);
    if (result?.ok === false) return setStatus(result.error || "收藏状态保存失败");
    setVideoFavorites((old) => favorite ? [item.path, ...old.filter((path) => path !== item.path)].slice(0, 500) : old.filter((path) => path !== item.path));
    setHistory((old) => old.map((entry) => entry.path === item.path ? { ...entry, favorite } : entry));
  };

  const toggleHistoryFavorites = () => {
    // 没有收藏时不要把“最近生成”过滤成空白，避免用户误以为视频被删除。
    if (!historyFavoritesOnly && !historyItems.some((item) => item.favorite)) {
      setStatus("还没有收藏视频，请先点击视频卡片上的星标");
      return;
    }
    setHistoryFavoritesOnly((value) => !value);
  };

  const renameVideo = async (item, event) => {
    event?.stopPropagation();
    const currentName = String(item.name || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    const nextName = window.prompt("重命名视频", currentName);
    if (!nextName || nextName.trim() === currentName) return;
    const result = await window.studio.renameVideo(item.path, nextName.trim());
    if (!result?.ok) return setStatus(result?.error || "重命名失败");
    if (videoFavorites.includes(item.path)) setVideoFavorites((old) => old.map((path) => path === item.path ? result.path : path));
    setSelectedVideo(previous => previous === item.path ? result.path : previous);
    await refreshHistory();
  };

  const revealVideo = async (item, event) => {
    event?.stopPropagation();
    const result = await window.studio.revealVideo(item.path);
    if (!result?.ok) setStatus(result?.error || "无法打开所在文件夹");
  };

  const copyVideoPath = async (item, event) => {
    event?.stopPropagation();
    const result = await window.studio.copyPath(item.path);
    setStatus(result?.ok ? "视频路径已复制" : (result?.error || "复制失败"));
  };

  const exportVideo = async (item, event) => {
    event?.stopPropagation();
    const result = await window.studio.exportVideo(item.path);
    if (result?.ok) setStatus("视频已导出");
    else if (!result?.canceled) setStatus(result?.error || "导出失败");
  };

  const openAssetLibrary = () => setAssetLibraryOpen(true);
  const useLibraryAsset = async (asset) => {
    if (!asset?.path) return;
    if (current.id === "r2v") await addReferencePaths([asset.path]);
    else if (current.media > 0) await addPaths([asset.path]);
    setAssetLibraryOpen(false);
  };
  const removeLibraryAssets = async (next) => {
    const retainedIds = new Set(next.map((item) => item.id));
    const removedPaths = assetLibrary.filter((item) => !retainedIds.has(item.id)).map((item) => item.path).filter(Boolean);
    try {
      persistCurrentDraft();
      const saved = await window.studio.savePreference?.(ASSET_LIBRARY_KEY, JSON.stringify(next));
      if (saved?.ok === false) return setStatus(saved.error || "素材库保存失败");
      setAssetLibrary(next);
      const result = await window.studio.pruneAssets?.(removedPaths);
      setStatus(result?.ok === false ? `记录已移除，部分副本清理失败：${result.error}` : `素材库已更新，清理 ${result?.removed || 0} 个未使用副本`);
    } catch (error) { setStatus(`素材库操作失败：${error.message}`); }
  };
  const removeLibraryAsset = (assetId) => removeLibraryAssets(assetLibrary.filter((asset) => asset.id !== assetId));
  const clearAssetLibrary = async () => {
    if (!assetLibrary.length) return;
    if (!window.confirm(`确定清空素材库中的 ${assetLibrary.length} 个素材吗？将清理未使用的副本，正在被草稿和任务引用的图片会保留。原始图片不会删除。`)) return;
    await removeLibraryAssets([]);
  };

  const runHealthCheck = async () => {
    setHealthOpen(true);
    setHealthState({ loading: true, data: null, error: "" });
    try { setHealthState({ loading: false, data: await window.studio.engineHealth(), error: "" }); }
    catch (error) { setHealthState({ loading: false, data: null, error: error.message || "自检失败" }); }
  };

  const loadStorageUsage = async () => {
    setStorageOpen(true);
    setStorageState({ loading: true, data: null, error: "" });
    try { setStorageState({ loading: false, data: await window.studio.storageUsage(), error: "" }); }
    catch (error) { setStorageState({ loading: false, data: null, error: error.message || "读取存储占用失败" }); }
  };

  const loadWorkflowBackups = async (workflowId = editorWorkflow) => {
    const items = await window.studio.listWorkflowBackups(workflowId).catch(() => []);
    setWorkflowBackups(Array.isArray(items) ? items : []);
  };

  const restoreWorkflowBackup = async (backup) => {
    if (!backup) return;
    const result = await window.studio.restoreWorkflowBackup(editorWorkflow, backup.id);
    if (!result?.ok) return setWorkflowEditorStatus(result?.error || "恢复失败");
    setWorkflowJson(result.content || "");
    setWorkflowIsCustom(true);
    setWorkflowEditorStatus(`已恢复备份：${backup.name}`);
    comfyWorkflowRef.current = "";
    await loadWorkflowBackups(editorWorkflow);
  };

  const exportStudioConfig = async () => {
    const payload = {
      version: 2,
      exportedAt: Date.now(),
      profile, theme, promptHistory, promptPresets, assetLibrary, videoFavorites,
      settings: { ...settings, fps: 24 },
      workflowDrafts: { ...workflowDraftsRef.current, [current.id]: currentDraft() },
      cutoutOptions, audioMuted, notificationsEnabled,
    };
    const result = await window.studio.exportConfig(payload);
    if (result?.ok) setStatus("配置已导出（含模式草稿和参数；模型与素材文件需另行保存）");
    else if (!result?.canceled) setStatus(result?.error || "配置导出失败");
  };

  const importStudioConfig = async () => {
    if (runPendingRef.current) return setStatus("请先完成当前操作，再恢复配置");
    const result = await window.studio.importConfig();
    if (!result?.ok) return result?.canceled ? undefined : setStatus(result?.error || "配置导入失败");
    let payload;
    try { payload = normalizeStudioConfig(result.payload); }
    catch (error) { return setStatus(error.message); }
    if (payload.profile && typeof payload.profile === "object") setProfile((old) => ({ ...old, ...payload.profile }));
    if (payload.theme === "light" || payload.theme === "dark") setTheme(payload.theme);
    if (Array.isArray(payload.promptPresets)) setPromptPresets(payload.promptPresets.slice(0, 50));
    if (Array.isArray(payload.assetLibrary)) setAssetLibrary(payload.assetLibrary.slice(0, 120));
    if (Array.isArray(payload.videoFavorites)) setVideoFavorites(payload.videoFavorites.map(String));
    if (payload.promptHistory && typeof payload.promptHistory === "object") setPromptHistory(payload.promptHistory);
    if (payload.settings && typeof payload.settings === "object") setSettings((old) => ({ ...old, ...payload.settings, fps: 24, batchCount: 1 }));
    if (payload.cutoutOptions) setCutoutOptions(old => ({ ...old, ...payload.cutoutOptions }));
    if (typeof payload.audioMuted === "boolean") setAudioMuted(payload.audioMuted);
    if (typeof payload.notificationsEnabled === "boolean") setNotificationsEnabled(payload.notificationsEnabled);
    if (payload.workflowDrafts) {
      workflowDraftsRef.current = payload.workflowDrafts;
      persistValue(WORKFLOW_DRAFTS_KEY, JSON.stringify(payload.workflowDrafts));
      const draft = payload.workflowDrafts[current.id];
      setFiles([...(draft?.files || []), ...Array(50).fill("")].slice(0, 50));
      setPreviews([...(draft?.previews || []), ...Array(50).fill("")].slice(0, 50));
      setPrompt(draft?.prompt || "");
      setPromptParts(draft?.promptParts || [{ type: "text", text: "" }]);
      setReferenceAssets((draft?.referenceAssets || []).map(asset => ({ ...asset, id: asset.id || asset.assetId, assetId: asset.assetId || asset.id })));
      setSettings({ ...DEFAULT_SETTINGS, ...(draft?.settings || {}), fps: 24, batchCount: 1 });
    }
    setStatus("配置已导入；素材文件需保留在对应位置");
  };

  useEffect(() => {
    if (!window.studio) {
      setStatus("桌面接口未连接");
      return undefined;
    }
    const handleStatus = (value) => {
      setStatus(value);
      if (String(value).includes("本地引擎已就绪")) setEngineReady(true);
      if (/已停止|启动超时|启动失败|便携包不完整/.test(String(value))) setEngineReady(false);
    };
    const removeStatus = window.studio.onStatus(handleStatus);
    const handleProgress = (value) => {
      const normalized = value && typeof value === "object" ? { ...value } : value;
      if (normalized?.jobId) {
        const previous = progressByJobRef.current.get(normalized.jobId);
        const previousValue = Number(previous?.value);
        if (previous?.attempt === normalized.attempt && Number.isFinite(previousValue) && Number.isFinite(Number(normalized.value))) normalized.value = Math.max(previousValue, Number(normalized.value));
        progressByJobRef.current.set(normalized.jobId, normalized);
      }
      syncComfyExecution(normalized);
      if (normalized) {
        if (progressClearTimerRef.current) {
          window.clearTimeout(progressClearTimerRef.current);
          progressClearTimerRef.current = null;
        }
        setActiveProgress(normalized);
        const percent = progressPercent(normalized);
        if (percent >= 100 || normalized.label === "完成" || normalized.label === "已完成") {
          const completedProgress = normalized;
          progressClearTimerRef.current = window.setTimeout(() => {
            setActiveProgress((currentProgress) => currentProgress === completedProgress ? null : currentProgress);
            progressClearTimerRef.current = null;
          }, 2200);
        }
      }
      if (normalized?.jobId) setQueueJobs((old) => old.map((job) => job.id === normalized.jobId ? { ...job, progress: normalized, state: job.state === "preparing" ? "running" : job.state } : job));
    };
    const removeProgress = window.studio.onProgress(handleProgress);
    const removeQueue = window.studio.onQueueUpdated((items) => {
      const jobs = Array.isArray(items) ? items : [];
      const runningIds = new Set(jobs.filter(job => ["preparing", "running"].includes(job.state)).map(job => job.id));
      for (const id of progressByJobRef.current.keys()) if (!runningIds.has(id)) progressByJobRef.current.delete(id);
      setActiveProgress(old => old?.jobId && !runningIds.has(old.jobId) ? null : old);
      setQueueJobs(jobs);
    });
    const removeQueueControl = window.studio.onQueueControl((value) => setQueuePaused(Boolean(value?.paused)));
    const removeQueueCompleted = window.studio.onQueueCompleted((job) => { refreshHistory(true); refreshCutouts(); setStatus(job?.workflowId === "cutout" ? "抠图完成" : "生成完成"); if (notificationsEnabled) window.studio.notify?.("MiniMax H3 Studio", `${job?.workflowName || "视频"} 已生成完成`); });
    const removeQueueFailed = window.studio.onQueueFailed((job) => { setStatus(`生成失败：${job?.error || "请查看队列详情"}`); if (notificationsEnabled) window.studio.notify?.("MiniMax H3 Studio", `${job?.workflowName || "视频"} 生成失败`); });
    const removeCutoutProgress = window.studio.onCutoutProgress?.((value) => {
      if (!value?.total) return;
      setStatus(`抠图处理中 ${Number(value.index || 0) + 1}/${value.total}：${value.label || "处理中"}`);
      setCutoutBatch((old) => {
        if (!old) return old;
        const index = Number(value.index) || 0;
        const items = [...(old.items || [])];
        items[index] = { ...(items[index] || {}), index, state: "running", progress: progressPercent(value), label: value.label || "处理中", nodeId: value.nodeId || "" };
        return { ...old, id: value.batchId || old.id, currentIndex: index, currentLabel: value.label || "处理中", items };
      });
    });
    const removeCutoutStarted = window.studio.onCutoutStarted?.((value) => {
      if (!value?.total) return;
      setCutoutBatch((old) => {
        const oldItems = old?.items || [];
        const items = Array.from({ length: value.total }, (_, index) => ({ ...(oldItems[index] || {}), index, name: oldItems[index]?.name || `图片 ${index + 1}`, state: oldItems[index]?.state || "queued", progress: oldItems[index]?.progress || 0 }));
        return { id: value.batchId || old?.id || "", total: value.total, completed: 0, failed: 0, canceled: false, items };
      });
    });
    const removeCutoutCompleted = window.studio.onCutoutCompleted?.((value) => {
      if (!value?.total) return;
      setCutoutBatch((old) => {
        if (!old) return old;
        const index = Number(value.index) || 0;
        const items = [...(old.items || [])];
        items[index] = { ...(items[index] || {}), index, state: "completed", progress: 100, label: "已完成", outputPath: value.outputPath || "" };
        return { ...old, id: value.batchId || old.id, completed: items.filter((item) => item.state === "completed").length, items };
      });
      refreshCutouts().then((updated) => {
        const item = updated.find((entry) => entry.path === value.outputPath);
        if (item) setCutoutRecentResults((old) => old.some((entry) => entry.id === item.id) ? old : [...old, item]);
      }).catch(() => {});
    });
    const removeCutoutFailed = window.studio.onCutoutFailed?.((value) => {
      if (!value?.total) return;
      setCutoutBatch((old) => {
        if (!old) return old;
        const index = Number(value.index) || 0;
        const items = [...(old.items || [])];
        items[index] = { ...(items[index] || {}), index, state: value.canceled ? "cancelled" : "failed", progress: 0, label: value.canceled ? "已取消" : "失败", error: value.error || "抠图失败" };
        if (value.canceled) for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
          if (!items[nextIndex] || items[nextIndex].state === "queued") items[nextIndex] = { ...(items[nextIndex] || {}), index: nextIndex, state: "cancelled", progress: 0, label: "未处理" };
        }
        return { ...old, id: value.batchId || old.id, failed: items.filter((item) => item.state === "failed").length, canceled: Boolean(value.canceled), items };
      });
    });
    window.studio.getAppVersion().then(setAppVersion).catch(() => {});
    const refreshEngineState = () => window.studio.getEngineState?.().then((state) => {
      if (typeof state?.ready === "boolean") setEngineReady(state.ready);
      if (state?.queueError) setStatus(state.queueError);
    }).catch(() => setEngineReady(false));
    refreshEngineState();
    const enginePoll = window.setInterval(refreshEngineState, 5000);
    window.studio.getBackendUrl().then((url) => { if (url) setEngineReady(true); }).catch(() => {});
    window.studio.getReferenceCapabilities?.().then((result) => {
      const max = Number(result?.images?.max);
      if (result?.ok && Number.isFinite(max) && max > 0) setReferenceImageLimit(max);
    }).catch(() => {});
    refreshHistory();
    refreshCutouts();
    window.studio.listQueue().then((items) => setQueueJobs(Array.isArray(items) ? items : [])).catch(() => {});
    window.studio.isQueuePaused().then((paused) => setQueuePaused(Boolean(paused))).catch(() => {});
    window.studio.setAudioMuted(audioMuted).catch(() => {});
    return () => {
      window.clearInterval(enginePoll);
      removeStatus?.(); removeProgress?.(); removeQueue?.(); removeQueueControl?.(); removeQueueCompleted?.(); removeQueueFailed?.(); removeCutoutProgress?.(); removeCutoutStarted?.(); removeCutoutCompleted?.(); removeCutoutFailed?.();
      if (progressClearTimerRef.current) window.clearTimeout(progressClearTimerRef.current);
      progressClearTimerRef.current = null;
    };
  }, [notificationsEnabled]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const saved = readStoredObject(CUTOUT_OPTIONS_KEY, {});
    if (saved && typeof saved === "object") setCutoutOptions((old) => ({ ...old, ...saved }));
  }, []);

  useEffect(() => {
    try { persistValue(CUTOUT_OPTIONS_KEY, JSON.stringify(cutoutOptions)); } catch (_) {}
  }, [cutoutOptions]);

  useEffect(() => {
    persistValue("minimax-h3-muted", String(audioMuted));
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
    persistValue("minimax-h3-profile", JSON.stringify(profile));
  }, [profile]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persistValue("minimax-h3-theme", theme);
  }, [theme]);

  useEffect(() => {
    persistValue(PROMPT_HISTORY_KEY, JSON.stringify(promptHistory));
  }, [promptHistory]);

  useEffect(() => {
    persistValue(PROMPT_PRESETS_KEY, JSON.stringify(promptPresets));
  }, [promptPresets]);

  useEffect(() => {
    persistValue(ASSET_LIBRARY_KEY, JSON.stringify(assetLibrary));
  }, [assetLibrary]);

  useEffect(() => {
    if (!assetLibraryOpen || !assetLibrary.length) return undefined;
    let cancelled = false;
    Promise.all(assetLibrary.map(async (asset) => {
      if (!asset?.path) return asset;
      const fileUrl = asset.fileUrl || await window.studio.fileUrl(asset.path).catch(() => "");
      return fileUrl ? { ...asset, fileUrl } : asset;
    })).then((items) => { if (!cancelled) setAssetLibrary(items); });
    return () => { cancelled = true; };
  }, [assetLibraryOpen]);

  useEffect(() => {
    persistValue(VIDEO_FAVORITES_KEY, JSON.stringify(videoFavorites));
  }, [videoFavorites]);

  useEffect(() => {
    persistValue(NOTIFICATIONS_KEY, String(notificationsEnabled));
  }, [notificationsEnabled]);

  useEffect(() => {
    const next = { ...workflowDraftsRef.current, [current.id]: currentDraft() };
    workflowDraftsRef.current = next;
    try { persistValue(WORKFLOW_DRAFTS_KEY, JSON.stringify(next)); } catch (_) {}
  }, [current.id, prompt, promptParts, files, previews, referenceAssets, settings]);

  useEffect(() => {
    if (current.id === "r2v") setPrompt(promptPartsToText(promptParts, referenceAssets));
  }, [current.id, promptParts, referenceAssets]);

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

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const mod = event.ctrlKey || event.metaKey;
      const editable = event.target?.closest?.("input, textarea, [contenteditable='true']");
      const overlayOpen = profileOpen || integrationOpen || assetPreview || assetLibraryOpen || healthOpen || storageOpen || queueDetailJob || previewVideo || workflowEditorOpen || promptPresetEditor;
      if (overlayOpen && event.key !== "Escape") return;
      if (mod && event.key === "Enter") {
        event.preventDefault();
        if (!queuePage && !running) run();
      } else if (event.key === "Delete" && current.id === "cutout" && !queuePage && !running && !assetPreview && !editable) {
        if (selectedCutoutIndex >= 0 && files[selectedCutoutIndex]) {
          event.preventDefault();
          clearImage(selectedCutoutIndex, { stopPropagation() {} });
        }
      } else if (event.key === "Escape") {
        setProfileOpen(false); setIntegrationOpen(false); setAssetPreview(null); setAssetLibraryOpen(false); setHealthOpen(false); setStorageOpen(false); setQueueDetailJob(null); setPreviewVideo(null);
      } else if (mod && event.shiftKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        const latest = Array.isArray(currentPromptHistory) ? currentPromptHistory[0] : null;
        if (latest) restorePromptHistory(latest);
      }
    };
    const onPaste = async (event) => {
      if (event.defaultPrevented || current.id !== "cutout" || queuePage || running || integrationOpen || assetPreview || assetLibraryOpen || healthOpen || storageOpen || queueDetailJob || previewVideo || workflowEditorOpen || profileOpen) return;
      const imageItems = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === "file" && String(item.type || "").toLowerCase().startsWith("image/"));
      if (!imageItems.length) return;
      event.preventDefault();
      const paths = [];
      for (const item of imageItems) {
        const file = item.getAsFile?.();
        if (!file) continue;
        const directPath = window.studio.getPathForFile?.(file) || file.path || "";
        if (directPath) { paths.push(directPath); continue; }
        try {
          const result = await window.studio.saveClipboardImage?.({ buffer: await file.arrayBuffer(), mimeType: file.type, name: file.name || "clipboard-image.png" });
          if (result?.ok && result.path) paths.push(result.path);
          else if (result?.error) setStatus(result.error);
        } catch (error) { setStatus(`粘贴图片失败：${error.message}`); }
      }
      if (paths.length) {
        const added = await addPaths(paths, files.filter(Boolean).length);
        if (added) setStatus(`已从剪贴板添加 ${added} 张图片`);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("paste", onPaste);
    return () => { document.removeEventListener("keydown", onKeyDown); document.removeEventListener("paste", onPaste); };
  });

  const rememberAssetPaths = async (paths) => {
    const clean = paths.filter((file) => String(file || "").trim() && imageExtensions.test(String(file)));
    if (!clean.length) return;
    const staged = [];
    for (const file of clean) {
      let result = null;
      try { result = window.studio.stageAsset ? await window.studio.stageAsset(file) : null; } catch (_) {}
      if (result?.ok && result.path) staged.push({ sourcePath: file, ...result });
    }
    if (!staged.length) return;
    setAssetLibrary((old) => {
      const existing = new Set(old.flatMap((asset) => [asset?.sourcePath, asset?.path].filter(Boolean).map(String)));
      const additions = staged.filter((asset) => !existing.has(asset.sourcePath)).map((asset) => ({ id: newAssetId(), path: asset.path, sourcePath: asset.sourcePath, fileUrl: asset.fileUrl, name: asset.name || String(asset.sourcePath).split(/[\\/]/).pop(), addedAt: Date.now() }));
      return [...additions, ...old].slice(0, 120);
    });
  };

  const addReferencePaths = async (paths) => {
    const candidates = paths.filter((file) => String(file || "").trim());
    const clean = candidates.filter((file) => imageExtensions.test(file));
    if (!clean.length) {
      if (candidates.length) setStatus("参考生视频仅支持图片文件");
      return;
    }
    const existing = new Set(referenceAssets.map((asset) => asset.filePath));
    const unique = clean.filter((file) => !existing.has(file));
    const available = Math.max(0, referenceImageLimit - referenceAssets.length);
    const accepted = unique.slice(0, available);
    const additions = [];
    for (const filePath of accepted) {
      const fileUrl = await window.studio.fileUrl(filePath);
      const assetId = newAssetId();
      additions.push({ id: assetId, assetId, type: "image", filePath, fileUrl, thumbnailUrl: fileUrl });
    }
    if (additions.length) setReferenceAssets((old) => [...old, ...additions]);
    await rememberAssetPaths(accepted);
    if (unique.length > accepted.length) setStatus(`最多支持 ${referenceImageLimit} 张参考图`);
    else if (clean.length < candidates.length) setStatus("已跳过不支持的文件，参考生视频仅接受图片");
  };

  const addPaths = async (paths, startIndex = files.findIndex((file) => !file), mode = "append") => {
    const candidates = paths.filter((file) => String(file || "").trim());
    const clean = candidates.filter((file) => current.video ? /\.(mp4|mov|mkv|webm|avi)$/i.test(file) : imageExtensions.test(file));
    if (candidates.length > clean.length) setStatus(`已跳过 ${candidates.length - clean.length} 个不支持的文件，请选择${current.video ? "视频" : "图片"}`);
    if (!clean.length) return 0;
    const isCutout = current.id === "cutout";
    const existingKeys = new Set(files.filter(Boolean).map((file) => String(file).toLowerCase()));
    const deduped = [];
    for (const file of clean) {
      const key = String(file).toLowerCase();
      if (mode !== "replace" && !["i2v", "multiframe"].includes(current.id) && existingKeys.has(key)) continue;
      if (!deduped.some((item) => String(item).toLowerCase() === key)) deduped.push(file);
    }
    if (!deduped.length) { setStatus("已跳过重复图片"); return 0; }
    const first = isCutout
      ? (startIndex >= 0 && startIndex < files.length && files[startIndex] ? startIndex : files.findIndex((file) => !file))
      : (startIndex < 0 ? files.length : startIndex);
    if (isCutout && first < 0) { setStatus("一次最多添加 50 张图片"); return 0; }
    const nextFiles = [...files];
    const nextPreviews = [...previews];
    let accepted = deduped;
    if (isCutout && mode === "replace" && first >= 0) {
      const replacement = deduped[0];
      nextFiles[first] = replacement;
      nextPreviews[first] = await window.studio.fileUrl(replacement);
      const appendAt = files.filter(Boolean).length;
      accepted = [replacement, ...deduped.slice(1, Math.max(1, nextFiles.length - appendAt))];
      for (let offset = 1; offset < accepted.length; offset += 1) {
        const index = appendAt + offset - 1;
        nextFiles[index] = accepted[offset];
        nextPreviews[index] = await window.studio.fileUrl(accepted[offset]);
      }
    } else {
      const capacity = isCutout ? nextFiles.length - Math.max(0, first) : Math.max(0, current.media - first);
      accepted = deduped.slice(0, capacity);
      for (let offset = 0; offset < accepted.length; offset += 1) {
        const index = first + offset;
        nextFiles[index] = accepted[offset];
        nextPreviews[index] = await window.studio.fileUrl(accepted[offset]);
      }
    }
    setFiles(nextFiles);
    setPreviews(nextPreviews);
    if (isCutout && accepted.length) setSelectedCutoutIndex(Math.max(0, first));
    await rememberAssetPaths(accepted.filter(file => imageExtensions.test(file)));
    if (deduped.length > accepted.length || (isCutout && mode === "replace" && deduped.length > accepted.length)) setStatus(isCutout ? "一次最多添加 50 张图片" : `最多支持 ${current.media} 张参考图`);
    return accepted.length;
  };

  const choose = async (index) => {
    const paths = await window.studio.pickFiles(current.video ? "video" : "image");
    if (paths?.length) await addPaths(paths, index, files[index] ? "replace" : "append");
  };

  const chooseReference = async () => {
    const paths = await window.studio.pickFiles("image");
    if (paths?.length) await addReferencePaths(paths);
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    setDragging(false);
    if (running) return;
    const paths = [];
    const droppedFiles = await collectDroppedFiles(event);
    for (const file of droppedFiles) {
      const filePath = window.studio.getPathForFile?.(file) || file.path || "";
      if (filePath) { paths.push(filePath); continue; }
      if (String(file.type || "").toLowerCase().startsWith("image/")) {
        try {
          const result = await window.studio.saveClipboardImage?.({ buffer: await file.arrayBuffer(), mimeType: file.type, name: file.name || "dropped-image.png" });
          if (result?.ok && result.path) paths.push(result.path);
        } catch (_) {}
      }
    }
    if (!paths.length && droppedFiles.length) { setStatus("拖入的文件夹中没有支持的图片"); return; }
    if (current.id === "r2v") await addReferencePaths(paths);
    else await addPaths(paths, current.id === "cutout" ? files.filter(Boolean).length : undefined);
  };

  const clearImage = (index, event) => {
    event.stopPropagation();
    const nextFiles = [...files];
    const nextPreviews = [...previews];
    nextFiles[index] = "";
    nextPreviews[index] = "";
    for (let i = index; current.id === "cutout" && i < nextFiles.length - 1; i += 1) {
      nextFiles[i] = nextFiles[i + 1];
      nextPreviews[i] = nextPreviews[i + 1];
    }
    nextFiles[nextFiles.length - 1] = "";
    nextPreviews[nextPreviews.length - 1] = "";
    setFiles(nextFiles);
    setPreviews(nextPreviews);
    if (current.id === "cutout") {
      const remaining = nextFiles.filter(Boolean).length;
      setSelectedCutoutIndex((old) => old < 0 || !remaining ? -1 : index < old ? old - 1 : Math.min(old, remaining - 1));
    }
  };

  const clearCutoutInputs = () => {
    if (current.id !== "cutout" || running) return;
    setFiles(Array(50).fill(""));
    setPreviews(Array(50).fill(""));
    setSelectedCutoutIndex(-1);
    setCutoutBatch(null);
    setStatus("已清空待处理图片");
  };

  const cancelCutoutBatch = async () => {
    if (!running) return;
    setStatus("正在停止抠图...");
    try {
      const result = await window.studio.cancelCutoutBatch?.();
      if (result?.ok) setStatus("正在停止当前图片，后续图片不会继续处理");
      else setStatus(result?.error || "没有正在处理的抠图任务");
    } catch (error) { setStatus(`停止失败：${error.message}`); }
  };

  const updateCutoutOptions = (patch) => setCutoutOptions((old) => ({ ...old, ...(patch || {}) }));

  const exportCutoutBatch = async (items) => {
    const ids = (Array.isArray(items) ? items : []).map((item) => item?.id).filter(Boolean);
    if (!ids.length) return;
    try {
      const result = await window.studio.exportCutoutBatch?.(ids);
      if (result?.ok) setStatus(`已导出 ${ids.length} 张抠图结果`);
      else if (!result?.canceled) setStatus(result?.error || "导出失败");
    } catch (error) { setStatus(`导出失败：${error.message}`); }
  };

  const deleteCutoutResult = async (id) => {
    try {
      const result = await window.studio.deleteCutout(id);
      if (result?.ok || result?.changed) {
        const updated = await refreshCutouts();
        const ids = new Set(updated.map(item => item.id));
        setCutoutRecentResults(old => old.filter(item => ids.has(item.id)));
      }
      if (!result?.ok && !result?.canceled) setStatus(result?.error || "删除失败");
    } catch (error) { setStatus(`删除失败：${error.message}`); }
  };

  const clearCutoutResults = async () => {
    try {
      const result = await window.studio.clearCutouts?.();
      if (result?.ok || result?.changed) {
        const updated = await refreshCutouts();
        const ids = new Set(updated.map(item => item.id));
        setCutoutRecentResults(old => old.filter(item => ids.has(item.id)));
      }
      if (result?.ok) setStatus("最近抠图已清空");
      else if (!result?.canceled) setStatus(result?.error || "清空失败");
    } catch (error) { setStatus(`清空失败：${error.message}`); }
  };

  const moveCutoutImage = (from, to) => {
    if (current.id !== "cutout" || running || from === to || from < 0 || to < 0) return;
    const compactFiles = files.filter(Boolean);
    const compactPreviews = previews.filter(Boolean);
    if (from >= compactFiles.length || to >= compactFiles.length) return;
    const nextFiles = [...compactFiles];
    const nextPreviews = [...compactPreviews];
    const [movedFile] = nextFiles.splice(from, 1);
    const [movedPreview] = nextPreviews.splice(from, 1);
    nextFiles.splice(to, 0, movedFile);
    nextPreviews.splice(to, 0, movedPreview);
    setFiles([...nextFiles, ...Array(50 - nextFiles.length).fill("")]);
    setPreviews([...nextPreviews, ...Array(50 - nextPreviews.length).fill("")]);
    setSelectedCutoutIndex((old) => {
      if (old < 0) return old;
      if (old === from) return to;
      if (from < old && old <= to) return old - 1;
      if (to <= old && old < from) return old + 1;
      return old;
    });
  };

  const removeReferenceAsset = (assetId) => setReferenceAssets((old) => old.filter((asset) => asset.id !== assetId));

  const reorderReferenceAsset = (sourceId, targetId) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setReferenceAssets((old) => {
      const from = old.findIndex((asset) => asset.id === sourceId);
      const to = old.findIndex((asset) => asset.id === targetId);
      if (from < 0 || to < 0 || from === to) return old;
      const next = [...old];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
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
    if (!result?.ok) return setUpdateState({ checking: false, downloading: false, hasUpdate: false, latestVersion: "", message: result?.error || "检查更新失败", notes: "" });
    if (result.unsupported) return setUpdateState({ checking: false, downloading: false, hasUpdate: false, latestVersion: "", message: "当前平台暂不支持在线更新", notes: "" });
    setUpdateState({ checking: false, downloading: false, hasUpdate: result.hasUpdate, latestVersion: result.latestVersion, message: result.hasUpdate ? `发现 v${result.latestVersion}` : `当前已是最新版本 v${result.currentVersion}`, notes: String(result.notes || "") });
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
    comfyExecutionNodeRef.current = "";
    const url = await window.studio.getBackendUrl().catch(() => "");
    setBackendUrl(url || "");
    await loadWorkflowBackups(editorWorkflow);
    await loadEditorWorkflow(editorWorkflow);
  };

  const switchEditorWorkflow = async (workflowId) => {
    if (workflowId === editorWorkflow) return;
    comfyWorkflowRef.current = "";
    comfyLoadInProgress.current = false;
    comfyExecutionNodeRef.current = "";
    comfyRef.current?.executeJavaScript("window.__h3SetExecutionNode?.(''); true;").catch(() => {});
    setEditorWorkflow(workflowId);
    setWorkflowJson("");
    setWorkflowIsCustom(false);
    setWorkflowBackups([]);
    await loadEditorWorkflow(workflowId);
    await loadWorkflowBackups(workflowId);
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
    setWorkflowEditorStatus("正在读取画布并保存...");
    let content = workflowJson;
    const expectedCanvasKey = `${editorWorkflow}:${workflowJson.length}:${workflowJson.slice(0, 48)}`;
    if (comfyReadyRef.current && comfyRef.current && comfyWorkflowRef.current === expectedCanvasKey) {
      try {
        const exported = await comfyRef.current.executeJavaScript("window.__h3ExportApiGraph?.()", true);
        if (exported && typeof exported === "object") content = JSON.stringify(exported, null, 2);
      } catch (error) {
        setWorkflowEditorBusy(false);
        return setWorkflowEditorStatus(`读取 ComfyUI 画布失败：${error?.message || "请确认画布已加载"}`);
      }
    }
    let result;
    try {
      result = await window.studio.saveWorkflowConfig(editorWorkflow, content);
    } catch (error) {
      setWorkflowEditorBusy(false);
      return setWorkflowEditorStatus(`保存失败：${error?.message || "请稍后重试"}`);
    }
    setWorkflowEditorBusy(false);
    if (!result?.ok) return setWorkflowEditorStatus(result?.error || "保存失败");
    setWorkflowJson(result.content || content);
    setWorkflowIsCustom(true);
    setWorkflowEditorStatus("已应用到当前模式，下一次生成将使用此工作流");
    await loadWorkflowBackups(editorWorkflow);
  };

  const resetEditorWorkflow = async () => {
    setWorkflowEditorBusy(true);
    const result = await window.studio.resetWorkflowConfig(editorWorkflow);
    setWorkflowEditorBusy(false);
    if (!result?.ok) return setWorkflowEditorStatus(result?.error || "恢复失败");
    setWorkflowJson(result.content || "");
    setWorkflowIsCustom(false);
    setWorkflowEditorStatus("已恢复默认工作流");
    await loadWorkflowBackups(editorWorkflow);
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

  const waitForComfyWorkflow = async (requestId, workflowName) => {
    const startedAt = Date.now();
    while (requestId === comfyLoadRequest.current && comfyRef.current && Date.now() - startedAt < 12000) {
      const state = await comfyRef.current.executeJavaScript("({ loaded: Number(window.__h3WorkflowLoadedRequest || 0), error: String(window.__h3WorkflowError || '') })", true).catch(() => null);
      if (state?.error) {
        setWorkflowEditorStatus(`工作流加载失败：${state.error}`);
        return false;
      }
      if (Number(state?.loaded) === requestId) {
        setWorkflowEditorStatus(`${workflowName} 已加载，可在画布中调整节点`);
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    }
    if (requestId === comfyLoadRequest.current) setWorkflowEditorStatus("工作流加载超时，请确认 ComfyUI 画布已就绪");
    return false;
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
      comfyRef.current.executeJavaScript(script)
        .then(() => waitForComfyWorkflow(requestId, workflowName))
        .catch((error) => setWorkflowEditorStatus(`ComfyUI 连接失败：${error?.message || "请稍后重试"}`));
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
      view.executeJavaScript(createComfyGuestScript(null, "", 0, false)).then(() => syncComfyExecution(latestProgressRef.current)).catch(() => {});
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

  const rememberPrompt = (value, workflowId = current.id, parts = []) => {
    const text = String(value || "").trim();
    if (!text) return;
    setPromptHistory((old) => {
      const previous = Array.isArray(old[workflowId]) ? old[workflowId] : [];
      const nextEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, parts: Array.isArray(parts) ? parts : [], createdAt: Date.now() };
      const nextEntries = [nextEntry, ...previous.filter((entry) => entry.text !== text)].slice(0, 30);
      return { ...old, [workflowId]: nextEntries };
    });
  };

  const deletePromptHistory = (entryId) => {
    setPromptHistory((old) => ({
      ...old,
      [current.id]: (Array.isArray(old[current.id]) ? old[current.id] : []).filter((entry) => entry.id !== entryId),
    }));
  };

  const clearPromptHistory = () => {
    setPromptHistory((old) => ({ ...old, [current.id]: [] }));
    setPromptHistoryOpen(false);
  };

  const openPromptPresetEditor = (preset = null) => {
    setPromptPresetEditor({ id: preset?.id || "", text: preset?.text || "" });
  };

  const commitPromptPreset = () => {
    if (!promptPresetEditor) return;
    const text = String(promptPresetEditor.text || "").replace(/\r\n?/g, "\n").trim().slice(0, 2000);
    if (!text) {
      setStatus("预设内容不能为空");
      return;
    }
    const duplicate = promptPresets.find((preset) => preset.text === text && preset.id !== promptPresetEditor.id);
    if (duplicate) {
      setStatus("已有相同的预设提示词");
      return;
    }
    setPromptPresets((old) => {
      if (promptPresetEditor.id) return old.map((preset) => preset.id === promptPresetEditor.id ? { ...preset, text } : preset);
      return [{ id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() }, ...old].slice(0, 50);
    });
    setPromptPresetEditor(null);
  };

  const deletePromptPreset = (presetId) => {
    setPromptPresets((old) => old.filter((preset) => preset.id !== presetId));
    if (promptPresetEditor?.id === presetId) setPromptPresetEditor(null);
  };

  const clearPromptPresets = () => {
    setPromptPresets([]);
    setPromptPresetEditor(null);
    setStatus("常用预设已清空");
  };

  const insertPromptPreset = (presetText) => {
    const insertion = String(presetText || "").trim();
    if (!insertion) return;
    if (current.id === "r2v") {
      setPromptParts((old) => {
        const currentText = promptPartsToText(old, referenceAssets);
        const separator = currentText && !/\s$/.test(currentText) ? "\n" : "";
        const available = Math.max(0, 2000 - currentText.length - separator.length);
        const nextText = insertion.slice(0, available);
        if (!nextText) return old;
        const next = Array.isArray(old) && old.length ? old.slice() : [{ type: "text", text: "" }];
        const last = next[next.length - 1];
        if (last?.type === "text") next[next.length - 1] = { ...last, text: `${last.text || ""}${separator}${nextText}` };
        else next.push({ type: "text", text: `${separator}${nextText}` });
        return next;
      });
      return;
    }
    setPrompt((old) => {
      const currentText = String(old || "");
      const separator = currentText && !/\s$/.test(currentText) ? "\n" : "";
      return `${currentText}${separator}${insertion}`.slice(0, 2000);
    });
  };

  const restorePromptHistory = (entry) => {
    if (current.id === "r2v" && Array.isArray(entry.parts) && entry.parts.length) {
      setPromptParts(entry.parts);
      setPrompt(promptPartsToText(entry.parts, referenceAssets));
    } else {
      setPrompt(entry.text || "");
      if (current.id === "r2v") setPromptParts([{ type: "text", text: entry.text || "" }]);
    }
    setPromptHistoryOpen(false);
  };

  const currentDraft = () => ({
    prompt: current.id === "r2v" ? "" : prompt,
    promptParts: current.id === "r2v" ? promptParts.map((part) => ({ ...part })) : [],
    files: files.slice(),
    previews: previews.slice(),
    referenceAssets: current.id === "r2v" ? referenceAssets.map((asset) => ({
      id: asset.id,
      assetId: asset.assetId || asset.id,
      type: "image",
      filePath: asset.filePath || "",
      fileUrl: asset.fileUrl || "",
      thumbnailUrl: asset.thumbnailUrl || asset.fileUrl || "",
      index: asset.index || 0,
    })) : [],
    settings: { ...settings, fps: 24, batchCount: 1 },
    savedAt: Date.now(),
  });

  const persistCurrentDraft = () => {
    const next = { ...workflowDraftsRef.current, [current.id]: currentDraft() };
    workflowDraftsRef.current = next;
    try { persistValue(WORKFLOW_DRAFTS_KEY, JSON.stringify(next)); } catch (_) {}
  };

  const selectWorkflow = (index) => {
    if (runPendingRef.current && index !== selected) return setStatus(current.id === "cutout" ? "抠图处理中，请先完成或停止当前批次" : "正在提交任务，请稍候再切换模式");
    persistCurrentDraft();
    setQueuePage(false);
    setVoicePage(false);
    setAiToolsPage(false);
    setSelected(index);
    const nextWorkflow = workflows[index];
    setEditorWorkflow(nextWorkflow.id);
    const draft = workflowDraftsRef.current[nextWorkflow.id];
    const restoredCutoutIndex = nextWorkflow.id === "cutout" && Array.isArray(draft?.files) ? draft.files.findIndex(Boolean) : -1;
    if (draft) {
      setFiles(Array.isArray(draft.files) ? [...draft.files, ...Array(50).fill("")].slice(0, 50) : Array(50).fill(""));
      setPreviews(Array.isArray(draft.previews) ? [...draft.previews, ...Array(50).fill("")].slice(0, 50) : Array(50).fill(""));
      setReferenceAssets(Array.isArray(draft.referenceAssets) ? draft.referenceAssets.map((asset, assetIndex) => ({ ...asset, id: asset.id || asset.assetId || newAssetId(), assetId: asset.assetId || asset.id || newAssetId(), index: asset.index || assetIndex + 1 })) : []);
      setPromptParts(Array.isArray(draft.promptParts) && draft.promptParts.length ? draft.promptParts.map((part) => ({ ...part })) : [{ type: "text", text: "" }]);
      setPrompt(String(draft.prompt || ""));
      setSettings({ ...DEFAULT_SETTINGS, ...(draft.settings || {}), fps: 24, batchCount: 1 });
    } else {
      setFiles(Array(50).fill(""));
      setPreviews(Array(50).fill(""));
      setReferenceAssets([]);
      setPromptParts([{ type: "text", text: "" }]);
      setSettings({ ...DEFAULT_SETTINGS, aspectRatio: index === 0 ? "1:1 (Square)" : "16:9 (Widescreen)" });
      setPrompt("");
    }
    setSelectedCutoutIndex(restoredCutoutIndex);
    setPreviewVideo(null);
    setAssetPreview(null);
    setCutoutRecentResults([]);
    setPromptHistoryOpen(false);
    setPromptPresetEditor(null);
    setStatus(engineReady ? "准备就绪" : "正在启动本地引擎...");
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

  const reorderQueueItem = async (jobId, targetJobId) => {
    if (!jobId || !targetJobId || jobId === targetJobId) return;
    const queued = queueJobs.filter((job) => job.state === "queued");
    const targetIndex = queued.findIndex((job) => job.id === targetJobId);
    if (targetIndex < 0) return;
    const result = await window.studio.reorderQueueItem(jobId, targetIndex);
    if (!result?.ok) setStatus(result?.error || "队列顺序调整失败");
    setQueueDragId("");
    await refreshQueue();
  };

  const queueAction = async (action, jobId, label) => {
    try {
      const result = await action(jobId);
      setStatus(result?.ok ? label : (result?.error || "队列操作失败"));
    } catch (error) { setStatus(`队列操作失败：${error.message}`); }
    await refreshQueue();
  };
  const cancelQueueItem = (jobId) => queueAction(window.studio.cancelQueueItem, jobId, "已请求取消任务");
  const removeQueueItem = (jobId) => queueAction(window.studio.removeQueueItem, jobId, "已移除任务");
  const retryQueueItem = (jobId) => queueAction(window.studio.retryQueueItem, jobId, "任务已重新加入队列");
  const toggleQueue = async () => {
    const result = queuePaused ? await window.studio.resumeQueue() : await window.studio.pauseQueue();
    if (!result?.ok) return setStatus(result?.error || "队列状态保存失败");
    setStatus(result.message || (result.paused ? "已暂停后续任务" : "已恢复队列"));
    setQueuePaused(Boolean(result.paused));
    await refreshQueue();
  };
  const clearQueue = async () => { await window.studio.clearQueue("finished"); await refreshQueue(); };

  const reuseQueueJob = async (job) => {
    if (runPendingRef.current) return setStatus("请先完成当前操作，再复用任务");
    const workflowIndex = workflows.findIndex((item) => item.id === job?.workflowId || item.name === job?.workflowName);
    if (workflowIndex < 0) return setStatus("找不到该任务对应的工作流");
    selectWorkflow(workflowIndex);
    setQueuePage(false);
    setVoicePage(false);
    setPromptPresetEditor(null);
    setPromptHistoryOpen(false);
    setDragging(false);
    setRunning(false);

    const workflow = workflows[workflowIndex];
    const savedSettings = job?.settings && typeof job.settings === "object" ? job.settings : {};
    setSettings({
      ...DEFAULT_SETTINGS,
      ...savedSettings,
      resolution: savedSettings.resolution || "standard",
      duration: Number(savedSettings.duration) || 5,
      aspectRatio: savedSettings.aspectRatio || (workflowIndex === 0 ? "1:1 (Square)" : "16:9 (Widescreen)"),
      fps: 24,
      seedMode: savedSettings.seedMode === "fixed" ? "fixed" : "random",
      seed: savedSettings.seed === undefined || savedSettings.seed === null ? "" : String(savedSettings.seed),
      batchCount: 1,
      negativePrompt: String(savedSettings.negativePrompt || ""),
    });

    const fileUrl = async (filePath) => {
      if (!filePath) return "";
      try { return await window.studio.fileUrl(filePath); } catch (_) { return ""; }
    };

    if (workflow.id === "r2v") {
      const savedAssets = Array.isArray(job?.referenceAssets) ? job.referenceAssets : [];
      const restoredAssets = [];
      for (const [index, asset] of savedAssets.entries()) {
        const filePath = String(asset?.filePath || asset?.sourcePath || "").trim();
        const previewUrl = await fileUrl(filePath);
        const restoredId = String(asset.assetId || asset.id || newAssetId());
        restoredAssets.push({
          ...asset,
          id: restoredId,
          assetId: restoredId,
          type: "image",
          filePath,
          fileUrl: previewUrl,
          thumbnailUrl: previewUrl,
          index: index + 1,
        });
      }
      setReferenceAssets(restoredAssets);
      const savedParts = Array.isArray(job?.promptParts) && job.promptParts.length
        ? job.promptParts
        : [{ type: "text", text: String(job?.prompt || "").replace(/<Picture\s+\d+>/g, "") }];
      setPromptParts(savedParts);
      setPrompt("");
      const missing = restoredAssets.filter(asset => !asset.fileUrl).length;
      setStatus(missing ? `已复用 Prompt，${missing} 张参考图不可用，请移除失效图片并重新添加` : "已复用参考图和 Prompt，可继续修改");
      return;
    }

    const savedMedia = Array.isArray(job?.mediaPaths) ? job.mediaPaths : [];
    const nextFiles = Array(50).fill("");
    const nextPreviews = Array(50).fill("");
    for (const [index, filePath] of savedMedia.slice(0, workflow.media).entries()) {
      nextFiles[index] = filePath;
      nextPreviews[index] = await fileUrl(filePath);
    }
    setFiles(nextFiles);
    setPreviews(nextPreviews);
    setReferenceAssets([]);
    setPromptParts([{ type: "text", text: "" }]);
    setPrompt(String(job?.prompt || "").replace(/<Picture\s+\d+>/g, ""));
    const missing = savedMedia.filter((filePath, index) => !filePath || !nextPreviews[index]).length;
    setStatus(missing ? `已复用 Prompt，${missing} 个参考素材不可用，请在原槽位重新添加` : workflow.media ? "已复用参考素材和 Prompt，可继续修改" : "已复用 Prompt 和参数，可继续修改");
  };

  const run = async () => {
    if (runPendingRef.current || running) return;
    if (!engineReady) return setStatus("本地引擎未就绪，请稍后重试");
    if (current.id === "r2v" && !referenceAssets.length) return setStatus("请先添加参考图片");
    if (current.media && current.id !== "r2v" && !files[0]) return setStatus("请先选择参考素材");
    const isCutout = current.id === "cutout";
    const selectedFiles = isCutout ? files.filter(Boolean) : files.slice(0, current.media);
    const firstEmpty = selectedFiles.findIndex((file) => !file);
    if (!isCutout && current.id !== "multiframe" && firstEmpty >= 0 && selectedFiles.slice(firstEmpty + 1).some(Boolean)) return setStatus("请按顺序添加参考图");
    if (isCutout && !selectedFiles.length) return setStatus("请先添加至少一张图片");
    // Keep the current prompt and media in place after enqueueing so variants can be adjusted quickly.
    runPendingRef.current = true;
    setRunning(true);
    let submittedCount = 0;
    try {
      const parsed = current.id === "r2v" ? parseReferencePrompt({ text: prompt, parts: promptParts }, referenceAssets) : null;
      if (String(parsed?.originalPrompt ?? prompt).length > 2000) throw new Error("Prompt 最多支持 2000 字，请缩短后重试");
      if (parsed?.invalidMentions?.length) throw new Error("有图片已删除，请修正 Prompt 中的失效引用");
      if (isCutout) {
        setCutoutBatch(null);
        setCutoutRecentResults([]);
        setCutoutBatch({ total: selectedFiles.length, completed: 0, failed: 0, canceled: false, items: selectedFiles.map((filePath, index) => ({ index, name: String(filePath).split(/[\\/]/).pop() || `图片 ${index + 1}`, state: "queued", progress: 0 })) });
        const result = await window.studio.runCutoutBatch?.({ workflow: current.file, media: selectedFiles, cutoutOptions });
        if (!result) throw new Error("抠图服务不可用，请重启软件");
        if (!result.ok && result.error) throw new Error(result.error);
        const updated = await refreshCutouts();
        const outputPaths = new Set((result.results || []).map((item) => item.outputPath).filter(Boolean));
        setCutoutRecentResults(updated.filter((item) => outputPaths.has(item.path)));
        if (result.canceled) {
          setStatus(`抠图已取消，完成 ${result.completed || 0}/${result.total || selectedFiles.length}`);
          return;
        }
        if (!result.ok) {
          setStatus(`抠图完成 ${result.completed || 0}/${result.total || selectedFiles.length}，失败 ${result.failed || 0} 张`);
          return;
        }
        setStatus(`抠图完成 ${result.completed}/${result.total}`);
        return;
      }
      const batchCount = batchCountValue(settings.batchCount);
      const baseSettings = isCutout ? {} : { ...settings, fps: 24, batchCount: 1, ...(current.id === "multiframe" ? { frameTimes: selectedFiles.flatMap((file, index) => file ? [settings.frameTimes?.[index] ?? [0, 1.5, 3, 4.5][index]] : []) } : {}) };
      const batchId = batchCount > 1 ? newAssetId() : "";
      const preflight = await window.studio.preflightWorkflow?.(current.id === "r2v"
        ? { workflow: current.file, referenceAssets: parsed.workflowInputs.images, settings: { ...baseSettings, batchCount } }
        : { workflow: current.file, media: selectedFiles.filter(Boolean), settings: { ...baseSettings, batchCount } });
      if (preflight && !preflight.ok) throw new Error(preflight.error || "生成前检查未通过");
      let lastResult = null;
      for (let index = 0; index < batchCount; index += 1) {
        const seed = settings.seedMode === "fixed" && Number.isFinite(Number(settings.seed))
          ? Math.max(0, Math.floor(Number(settings.seed)))
          : randomSeed();
        const jobSettings = isCutout ? {} : { ...baseSettings, seed };
        const result = await window.studio.enqueue(current.id === "r2v"
          ? { workflow: current.file, prompt: parsed.expandedPrompt, originalPrompt: prompt, promptParts, references: parsed.references, referenceAssets: parsed.workflowInputs.images, settings: jobSettings, batchId, batchIndex: index + 1, batchTotal: batchCount }
          : { workflow: current.file, prompt: isCutout ? "" : prompt, originalPrompt: isCutout ? "" : prompt, media: selectedFiles.filter(Boolean), settings: jobSettings, batchId, batchIndex: index + 1, batchTotal: batchCount });
        if (!result?.ok) throw new Error(result?.error || "加入队列失败");
        submittedCount += 1;
        lastResult = result;
      }
      if (!isCutout) rememberPrompt(prompt, current.id, current.id === "r2v" ? promptParts : []);
      await refreshQueue();
      const queueMessage = batchCount > 1
        ? `已加入队列 ${batchCount} 个任务`
        : (lastResult?.position > 1 ? `已加入队列，第 ${lastResult.position} 位` : "已加入队列，准备生成");
      const warningText = Array.isArray(preflight?.warnings) && preflight.warnings.length
        ? ` · 检查提示：${preflight.warnings.slice(0, 2).join("；")}`
        : "";
      setStatus(`${queueMessage}${queuePaused ? " · 队列已暂停，请到视频队列继续" : ""}${warningText}`);
    } catch (error) {
      setStatus(submittedCount ? `已加入 ${submittedCount} 个任务，后续提交失败：${error.message}。请到视频队列查看` : `${isCutout ? "抠图失败" : "加入队列失败"}：${error.message}`);
    } finally {
      runPendingRef.current = false;
      setRunning(false);
    }
  };

  return <div className="app-shell">
    <main className="workspace">
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="brand-mark">H3</span><span>Studio</span></div>
        <nav>
          {[{ label: "基础生成", ids: ["i2v", "r2v", "t2v"] }, { label: "视频控制", ids: ["continuation", "multiframe", "control"] }].map(group => <div className="navigation-group" key={group.label}><div className="section-label">{group.label}</div>{group.ids.map(id => { const index = workflows.findIndex(item => item.id === id); const item = workflows[index]; return <button className={`workflow-card ${!queuePage && !voicePage && !aiToolsPage && selected === index ? "active" : ""}`} key={id} onClick={() => selectWorkflow(index)}><span className="workflow-icon"><NavigationIcon name={item.id} /></span><span>{item.name}</span><span className="chevron">›</span></button>; })}</div>)}
          {["视频工具", "图片工具"].map(group => <div className="navigation-group" key={group}><div className="section-label">{group}</div>{aiTools.filter(item => item.group === group).map(item => <button key={item.id} className={`workflow-card voice-link ${aiToolsPage && aiToolKind === item.id ? "active" : ""}`} onClick={() => { setVoicePage(false); setAiToolKind(item.id); setAiToolsPage(true); setQueuePage(false); }}><span className="workflow-icon"><NavigationIcon name={item.id} /></span><span>{item.title}</span><span className="chevron">›</span></button>)}{group === "图片工具" && <button className={`workflow-card ${!queuePage && !voicePage && !aiToolsPage && current.id === "cutout" ? "active" : ""}`} onClick={() => selectWorkflow(workflows.findIndex(item => item.id === "cutout"))}><span className="workflow-icon"><NavigationIcon name="cutout" /></span><span>批量自动抠图</span><span className="chevron">›</span></button>}</div>)}
          <div className="navigation-group"><div className="section-label">声音工具</div><button className={`workflow-card voice-link ${voicePage ? "active" : ""}`} onClick={() => { setAiToolsPage(false); setVoicePage(true); setQueuePage(false); }}><span className="workflow-icon"><NavigationIcon name="voice" /></span><span>语音合成</span><span className="chevron">›</span></button></div>
          <div className="section-label">任务</div>
          <button className={`workflow-card queue-link ${queuePage ? "active" : ""}`} onClick={() => { setVoicePage(false); setAiToolsPage(false); setQueuePage(true); }}><span className="workflow-icon"><NavigationIcon name="queue" /></span><span>视频队列</span>{queueWaitingCount > 0 && <b className="queue-count">{queueWaitingCount}</b>}</button>
        </nav>
         <div className="sidebar-footer"><i className={`dot ${engineReady ? "" : "offline"}`} /><span>本地引擎</span><small>{hardwareText}</small></div>
      </aside>
      <section className="content">
        {preferenceError && <div className="generation-feedback" role="alert"><span>{preferenceError}</span><button onClick={() => setPreferenceError("")}>关闭提示</button></div>}
        <header className="page-header">
          <div className="content-heading"><h1>{aiToolsPage ? aiTools.find(item => item.id === aiToolKind)?.title : voicePage ? "语音合成" : queuePage ? "视频队列" : current.name}</h1><p>{aiToolsPage ? aiTools.find(item => item.id === aiToolKind)?.description : voicePage ? "将文字变成自然语音，为创作增添声音" : queuePage ? "按顺序管理本地视频生成任务" : current.id === "t2v" ? "将你的想法变成视频" : current.id === "i2v" ? "让静态画面拥有镜头运动" : current.id === "cutout" ? "自动移除背景，导出透明 PNG" : current.description || "用参考图保持角色与风格一致"}</p></div>
          <div className="page-tools">
            {queuePage && <ProgressIndicator progress={activeProgress} />}

            <button className="icon-button audio-toggle" title={audioMuted ? "开启声音" : "关闭声音"} aria-label={audioMuted ? "开启声音" : "关闭声音"} onClick={() => setAudioMuted((muted) => !muted)}><NavigationIcon name={audioMuted ? "muted" : "sound"} /></button>
            <div className="profile-anchor" ref={profileRef}><button className="profile-trigger" title="账户设置" onClick={() => setProfileOpen((open) => !open)}><span className="avatar avatar-small">{profile.avatar ? <img src={profile.avatar} alt="" /> : profile.name.slice(0, 1)}</span><span className="profile-name">{profile.name}</span><span className="profile-caret">⌄</span></button>{profileOpen && <div className="profile-menu"><div className="menu-heading"><span>账户设置</span><button className="menu-close" onClick={() => setProfileOpen(false)}>×</button></div><div className="profile-editor"><span className="avatar avatar-large">{profile.avatar ? <img src={profile.avatar} alt="" /> : profile.name.slice(0, 1)}</span><button className="avatar-change" onClick={chooseAvatar}>更换头像</button></div><label className="menu-label">用户名<input value={profile.name} maxLength={24} onChange={(event) => setProfile((old) => ({ ...old, name: event.target.value }))} /></label><div className="theme-row"><span>界面主题</span><div className="theme-switch"><button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>深色</button><button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>浅色</button></div></div><div className="update-row"><span>版本更新<small>v{appVersion}</small></span><button disabled={updateState.checking || updateState.downloading} onClick={updateState.hasUpdate ? applyUpdate : checkUpdates}>{updateState.downloading ? "下载中..." : updateState.hasUpdate ? `更新到 v${updateState.latestVersion}` : "检查更新"}</button></div>{updateState.message && <div className={`update-message ${updateState.hasUpdate ? "available" : ""}`}>{updateState.message}</div>}<div className="settings-action-grid"><button onClick={runHealthCheck}>引擎自检</button><button onClick={loadStorageUsage}>存储占用</button><button onClick={exportStudioConfig}>备份配置</button><button onClick={importStudioConfig}>恢复配置</button></div><label className="notification-toggle"><input type="checkbox" checked={notificationsEnabled} onChange={(event) => setNotificationsEnabled(event.target.checked)} />生成完成通知</label><button className="workflow-settings-button" onClick={() => { setProfileOpen(false); setIntegrationOpen(true); }}>CLI 与接口调用<span>安装命令、调用示例 · 一键复制</span></button><button className="workflow-settings-button" onClick={openWorkflowEditor}>高级工作流<span>配置 ComfyUI 节点与参数</span></button></div>}</div>
          </div>
        </header>
        <VoiceWorkspace active={voicePage} />
        <AiToolsWorkspace active={aiToolsPage} tool={aiToolKind} />
        {voicePage || aiToolsPage ? null : queuePage ? (
          <section className="queue-page">
            <div className="generation-feedback" role="status"><span>{status}</span></div>
            <div className="queue-toolbar">
              <div><strong>{queueWaitingCount} 个待处理</strong><span>{queuePaused ? "已暂停，不会启动新的任务" : "本地引擎按顺序执行"}</span>{queueEtaText && <small className="queue-eta">{queueEtaText}</small>}</div>
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
                   const detailStep = Number(job.progress?.detailStep);
                   const detailStepMax = Number(job.progress?.detailStepMax);
                   const hasNodeStep = Number.isFinite(nodeStep) && Number.isFinite(nodeTotal) && nodeTotal > 0;
                   const hasDetailStep = Number.isFinite(detailStep) && Number.isFinite(detailStepMax) && detailStepMax > 0;
                   const stepText = [
                     hasNodeStep ? `节点 ${Math.max(1, Math.min(nodeTotal, nodeStep || 1))}/${nodeTotal}` : "",
                     hasDetailStep ? `采样 ${Math.max(0, Math.min(detailStepMax, detailStep || 0))}/${detailStepMax} 步` : "",
                   ].filter(Boolean).join(" · ");
                  return <article className={`queue-item queue-${job.state} ${queueDragId === job.id ? "is-dragging" : ""}`} key={job.id} draggable={job.state === "queued"} onDragStart={(event) => { if (job.state !== "queued") { event.preventDefault(); return; } setQueueDragId(job.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/queue-job-id", job.id); }} onDragEnd={() => setQueueDragId("")} onDragOver={(event) => { event.preventDefault(); if (job.state === "queued" && queueDragId && queueDragId !== job.id) event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); const sourceId = event.dataTransfer.getData("text/queue-job-id") || queueDragId; reorderQueueItem(sourceId, job.id); }}>
                    <div className="queue-item-mark">{index + 1}</div>
                    <div className="queue-item-media">{mediaPreviews.length ? <>{mediaPreviews.slice(0, 3).map((url) => /\.(mp4|mov|mkv|webm|avi)$/i.test(url) ? <video key={url} src={url} muted preload="metadata" /> : <img key={url} src={url} alt="" loading="lazy" />)}{mediaPreviews.length > 3 && <span>+{mediaPreviews.length - 3}</span>}</> : <span className="queue-item-media-placeholder">{job.mediaCount ? `${job.mediaCount} 张` : job.workflowName?.slice(0, 1) || "视频"}</span>}</div>
                    <div className="queue-item-main">
                       <div className="queue-item-head"><strong>{job.workflowName}</strong><span className={`queue-state ${job.outputMissing ? "queue-state-missing" : ""}`}>{queueStateLabel(job.outputMissing ? "output-missing" : job.state)}</span>{job.batchTotal > 1 && <span className="queue-batch">批次 {job.batchIndex}/{job.batchTotal}</span>}</div>
                      <p>{job.originalPrompt || job.prompt || "未填写提示词"}</p>
                      <small>{job.settings?.aspectRatio || "默认画幅"} · {resolutionDisplay(job.settings?.resolution, job.settings?.aspectRatio)} · {job.settings?.duration || 5} 秒 · {queueTime(job.createdAt)}{job.batchTotal > 1 ? ` · 批量 ${job.batchIndex}/${job.batchTotal}` : ""}</small>
                      {elapsed && <div className="queue-timing"><span>{terminal ? "生成用时" : "当前用时"} {elapsed}</span></div>}
                      {["preparing", "running"].includes(job.state) && <><div className="queue-step"><span>{job.progress?.label || "处理中"}</span>{stepText && <small>{stepText}</small>}</div><div className="queue-progress"><div className={job.progress?.indeterminate ? "indeterminate" : ""}><i style={{ width: `${jobPercent}%` }} /></div><b>{jobPercent}%</b></div></>}
                      {job.outputMissing && <div className="queue-error">结果文件已被移动或删除，可移除记录或复用输入重新生成。</div>}
                      {job.error && <div className="queue-error">{job.error}</div>}
                    </div>
                    <div className="queue-item-actions"><button className="queue-action subtle" onClick={() => setQueueDetailJob(job)}>详情</button><button className="queue-action reuse" onClick={() => reuseQueueJob(job)}>复用输入</button>{["queued", "preparing", "running"].includes(job.state) && <button className="queue-action danger" onClick={() => cancelQueueItem(job.id)}>{job.state === "running" ? "停止" : "取消"}</button>}{["failed", "cancelled", "interrupted"].includes(job.state) && <button className="queue-action" onClick={() => retryQueueItem(job.id)}>重试</button>}{job.state === "completed" && job.outputPath && !job.outputMissing && <button className="queue-action" onClick={() => window.studio.openVideo(job.outputPath)}>打开视频</button>}{terminal && <button className="queue-action subtle" onClick={() => removeQueueItem(job.id)}>移除</button>}</div>
                  </article>;
                })}
              </div>
            ) : <div className="queue-empty"><strong>队列为空</strong><span>在视频创作页面点击“加入队列”，任务会出现在这里。</span><button className="empty-action" onClick={() => selectWorkflow(workflows.findIndex(item => item.id === "t2v"))}>开始创作视频 →</button></div>}
          </section>
        ) : current.id === "cutout" ? <CutoutWorkspace
          files={files.filter(Boolean)} previews={files.flatMap((file, index) => file ? [previews[index] || ""] : [])} history={cutoutHistory} recentResults={cutoutRecentResults} dragging={dragging} selectedIndex={selectedCutoutIndex} onSelect={setSelectedCutoutIndex}
          busy={running} engineReady={engineReady} status={status} cutoutOptions={cutoutOptions} cutoutBatch={cutoutBatch}
          onChoose={(index) => choose(Number.isInteger(index) ? index : files.filter(Boolean).length)} onRemove={(index, event) => clearImage(index, event)}
          onDrop={handleDrop} onDragChange={setDragging} onOpenLibrary={openAssetLibrary}
          onRun={run} onPreview={setAssetPreview} onRefresh={refreshCutouts}
          onClearInputs={clearCutoutInputs} onMove={moveCutoutImage} onCancel={cancelCutoutBatch} onExportBatch={exportCutoutBatch} onSetOptions={updateCutoutOptions}
          onOpen={async (filePath) => {
            try { const result = window.studio.revealVideo ? await window.studio.revealVideo(filePath) : await window.studio.openVideo(filePath); if (result?.ok === false) setStatus(result.error || "打开文件位置失败"); }
            catch (error) { setStatus(`打开文件位置失败：${error.message}`); }
          }}
          onDelete={deleteCutoutResult}
          onClear={clearCutoutResults}
        /> : <>
          <div className={`creation-grid ${current.media ? "with-media" : "no-media"}`}>
            {["continuation", "multiframe", "control"].includes(current.id) ? <GenerationInputs workflow={current} files={files} previews={previews} settings={settings} disabled={running} onChoose={choose} onRemove={clearImage} onDrop={handleDrop} onSettings={patch => setSettings(old => ({ ...old, ...patch }))} /> : current.id === "r2v" ? <ReferenceAssetsPanel assets={referenceAssets} limit={referenceImageLimit} dragging={dragging} disabled={running} onChoose={chooseReference} onDrop={handleDrop} onRemove={removeReferenceAsset} onPreview={setAssetPreview} onReorder={reorderReferenceAsset} onDragStateChange={setDragging} onOpenLibrary={openAssetLibrary} /> : current.media > 0 && <section className="media-section"><div className="section-heading"><div><span>{current.id === "i2v" ? "首尾帧" : "参考图片"}</span><em>{selectedCount} / {current.media}</em></div><button className="section-link-button" onClick={openAssetLibrary}>素材库</button></div><div className={`media-grid ${dragging ? "is-dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; setDragging(true); }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={handleDrop}>{Array.from({ length: visibleMediaCount }).map((_, i) => <button className={`dropzone ${files[i] ? "has-file" : ""}`} disabled={running} key={i} onClick={() => choose(i)}>{files[i] ? <><img className="preview-image" src={previews[i]} alt="" /><span className="preview-overlay"><b>{files[i].split(/[\\/]/).pop()}</b><small>点击替换</small></span><span className="clear-image" title="移除图片" onClick={(event) => clearImage(i, event)}>×</span></> : <><span className="upload-symbol">+</span><b>{current.id === "i2v" ? (i === 0 ? "添加首帧" : "添加尾帧（可选）") : i === 0 ? "添加参考图片" : "继续添加"}</b><small>PNG / JPG / WEBP</small></>}</button>)}</div></section>}
          <section className="composer"><div className="composer-label"><div className="composer-label-title"><span>提示词</span><em>{prompt.length} / 2000</em></div><div className="composer-label-actions"><button className={`prompt-history-toggle ${promptHistoryOpen ? "active" : ""}`} onClick={() => setPromptHistoryOpen((open) => !open)}>提示词历史{currentPromptHistory.length > 0 && <b>{currentPromptHistory.length}</b>}</button></div></div>{promptHistoryOpen && <div className="prompt-history-panel"><div className="prompt-history-head"><span>提示词历史</span>{currentPromptHistory.length > 0 && <button onClick={clearPromptHistory}>清空</button>}</div>{currentPromptHistory.length > 0 ? <div className="prompt-history-list">{currentPromptHistory.map((entry) => <div className="prompt-history-item" key={entry.id}><button className="prompt-history-use" title={entry.text} onClick={() => restorePromptHistory(entry)}>{entry.text}</button><button className="prompt-history-delete" title="删除这条提示词" aria-label="删除这条提示词" onClick={() => deletePromptHistory(entry.id)}>×</button></div>)}</div> : <div className="prompt-history-empty">暂无历史记录</div>}</div>}{current.id === "r2v" ? <ReferencePromptEditor parts={promptParts} assets={referenceAssets} onChange={(next) => setPromptParts(next)} disabled={running} placeholder="上传参考图片，输入文字或通过 @ 引用素材，自由描述不同素材的用途与关系。" /> : <textarea value={prompt} maxLength={2000} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想生成的视频画面、镜头和声音..." />}<section className="prompt-presets" aria-label="常用预设"><div className="prompt-presets-head"><span>常用预设</span><div>{promptPresets.length > 0 && <button className="prompt-presets-clear" onClick={clearPromptPresets}>清空</button>}<button className="prompt-presets-add" onClick={() => openPromptPresetEditor()}>＋ 添加</button></div></div>{promptPresetEditor && <div className="prompt-preset-editor"><textarea autoFocus value={promptPresetEditor.text} maxLength={2000} rows={2} onChange={(event) => setPromptPresetEditor((old) => old ? { ...old, text: event.target.value } : old)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commitPromptPreset(); } }} placeholder="输入常用的提示词，例如：镜头缓慢推进，光影自然" /><div className="prompt-preset-editor-actions"><span>最多 2000 字 · Ctrl/⌘ + Enter 保存</span><div><button onClick={() => setPromptPresetEditor(null)}>取消</button><button className="primary" onClick={commitPromptPreset}>保存</button></div></div></div>}{promptPresets.length > 0 ? <div className="prompt-presets-list">{promptPresets.map((preset) => <div className="prompt-preset" key={preset.id}><button className="prompt-preset-use" title="点击插入提示词" onClick={() => insertPromptPreset(preset.text)}>{preset.text}</button><div className="prompt-preset-actions"><button title="编辑预设" aria-label={`编辑预设：${preset.text}`} onClick={() => openPromptPresetEditor(preset)}>✎</button><button title="删除预设" aria-label={`删除预设：${preset.text}`} onClick={() => deletePromptPreset(preset.id)}>×</button></div></div>)}</div> : <div className="prompt-preset-empty">暂无预设，点击“添加”创建常用提示词</div>}</section><div className="composer-bar"><div className="generation-controls"><label>画幅<select value={settings.aspectRatio} onChange={(e) => setSettings((old) => ({ ...old, aspectRatio: e.target.value }))}><option value="16:9 (Widescreen)">16:9</option><option value="1:1 (Square)">1:1</option><option value="9:16 (Portrait Widescreen)">9:16</option></select></label><label>分辨率<select aria-label="输出分辨率" value={settings.resolution} onChange={(e) => setSettings((old) => ({ ...old, resolution: e.target.value }))}><option value="standard">{resolutionDisplay("standard", settings.aspectRatio)}</option><option value="hd">{resolutionDisplay("hd", settings.aspectRatio)}</option><option value="ultra" disabled={settings.samplingMode === "turbo4" && ["i2v", "t2v", "continuation"].includes(current.id)}>{resolutionDisplay("ultra", settings.aspectRatio)}</option></select></label><label>时长<select value={settings.duration} onChange={(e) => setSettings((old) => ({ ...old, duration: Number(e.target.value) }))}><option value="5">5 秒</option><option value="8">8 秒</option><option value="10">10 秒</option></select></label><label>批量<input className="generation-number" type="number" min="1" max="8" step="1" value={settings.batchCount} onChange={(e) => setSettings((old) => ({ ...old, batchCount: batchCountValue(e.target.value) }))} /></label><label>随机种子<select value={settings.seedMode} onChange={(e) => setSettings((old) => ({ ...old, seedMode: e.target.value }))}><option value="random">随机</option><option value="fixed">固定</option></select></label>{settings.seedMode === "fixed" && <input className="generation-seed" type="number" min="0" max="9007199254740991" step="1" value={settings.seed} onChange={(e) => setSettings((old) => ({ ...old, seed: e.target.value }))} placeholder="随机种子" />}<label>速度与质量<select aria-label="生成模式" value={settings.samplingMode || "quality"} onChange={e => setSettings(old => ({ ...old, samplingMode: e.target.value, resolution: e.target.value === "turbo4" && old.resolution === "ultra" ? "hd" : old.resolution }))}><option value="quality">标准质量 · 20 步</option><option value="turbo4">快速 · 4 步</option>{["i2v", "t2v", "continuation"].includes(current.id) && <option value="turbo8">均衡 · 8 步</option>}</select></label><label>特效风格<select aria-label="特效风格" value={settings.style || ""} onChange={e => setSettings(old => ({ ...old, style: e.target.value }))}><option value="">无特效</option>{generationStyles.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}</select></label></div><button className="run-button" disabled={running || !engineReady} onClick={run}>{running ? "加入中..." : "加入队列  →"}</button></div></section>
          </div>
          <div className="generation-feedback" role="status"><span>{status}</span><button onClick={() => { setVoicePage(false); setQueuePage(true); }}>{queuePaused ? "队列已暂停 · 去查看" : `视频队列${queueWaitingCount ? ` · ${queueWaitingCount} 个待处理` : ""}`} →</button></div>
          <section className="results-section">
            <div className="section-heading">
              <div><span>最近生成</span><em>{visibleHistory.length ? `${visibleHistory.length} 个视频` : ""}</em></div>
              <div className="results-tools">
                <input className="history-search" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索视频或提示词" aria-label="搜索最近生成" />
                {historyItems.length > 0 && <button className={`refresh-button ${historyFavoritesOnly ? "active" : ""}`} onClick={toggleHistoryFavorites} aria-pressed={historyFavoritesOnly} title={historyFavoritesOnly ? "显示全部最近生成" : "只显示已收藏的视频"}>{historyFavoritesOnly ? "显示全部" : "仅收藏"}</button>}
                {historyItems.length > 0 && <button className="clear-button" title="删除当前模式的全部视频文件" onClick={clearHistory}>删除全部视频</button>}
                <button className="refresh-button" onClick={() => refreshHistory()}>刷新</button>
              </div>
            </div>
            {visibleHistory.length ? <div className="history-groups">{historyGroups.map((group) => <section className={`history-group history-group-${group.key}`} key={group.key}>
              <div className="history-group-heading"><span>{group.label}</span><small>{group.ratio}</small><em>{group.items.length} 个</em></div>
              <div className="gallery">{group.items.map((item) => <article className={`video-card ${activeVideo?.path === item.path ? "selected" : ""}`} key={item.path}
                onClick={(event) => { const video = event.currentTarget.querySelector("video"); video?.pause(); setSelectedVideo(item.path); setVideoMenuPath(""); setPreviewVideo(item); }}
                onMouseEnter={(event) => { const video = event.currentTarget.querySelector("video"); video?.play().catch(() => {}); }}
                onMouseLeave={(event) => { setVideoMenuPath(""); const video = event.currentTarget.querySelector("video"); if (video) { video.pause(); video.currentTime = 0; } }}>
                <div className="video-thumb" data-aspect={videoAspectClass(item)}>
                  <VideoThumbnail item={item} muted={audioMuted} onLoadedMetadata={syncVideoNativeAspect} />
                  <div className="video-card-hover-actions">
                    <button title={item.favorite ? "取消收藏" : "收藏视频"} onClick={(event) => toggleVideoFavorite(item, event)}>{item.favorite ? "★" : "☆"}</button>
                    <button className="video-more-trigger" title="更多操作" aria-label="更多操作" aria-expanded={videoMenuPath === item.path} onClick={(event) => { event.stopPropagation(); setVideoMenuPath((path) => path === item.path ? "" : item.path); }}>⋯</button>
                    {videoMenuPath === item.path && <div className="video-more-menu" onClick={(event) => event.stopPropagation()}>
                      <button onClick={(event) => revealVideo(item, event)}>打开所在文件夹</button>
                      <button onClick={(event) => copyVideoPath(item, event)}>复制路径</button>
                      <button onClick={(event) => renameVideo(item, event)}>重命名</button>
                      <button onClick={(event) => exportVideo(item, event)}>导出视频</button>
                    </div>}
                    <button className="delete-video" title="删除视频" aria-label="删除视频" onClick={(event) => deleteVideo(item, event)}>×</button>
                  </div>
                </div>
                <div className="video-card-copy"><strong>{item.name}</strong><small>{formatDate(item.modified)} · {formatSize(item.size)}{item.resolution ? ` · ${historyResolutionDisplay(item)}` : ""}{item.fps ? ` · ${item.fps}fps` : ""}</small></div>
              </article>)}</div>
            </section>)}</div> : <div className="recent-empty">{historyFavoritesOnly && historyItems.length > 0 ? "暂无收藏视频，请点击卡片上的星标，或选择“显示全部”" : "暂无生成记录"}</div>}
          </section>
        </>}
      </section>
    </main>
    {workflowEditorOpen && <div className="workflow-modal-backdrop" role="dialog" aria-modal="true"><section className="workflow-modal"><header className="workflow-modal-header"><div><h2>高级工作流</h2><p>在 ComfyUI 中调整节点，保存后应用到当前模式</p></div><div className="workflow-modal-tools"><ProgressIndicator progress={activeProgress} /><button className="menu-close" onClick={() => setWorkflowEditorOpen(false)} aria-label="关闭">×</button></div></header><div className="workflow-modal-body"><aside className="workflow-editor-nav"><span>工作流</span>{workflows.map((item) => <button key={item.id} className={editorWorkflow === item.id ? "active" : ""} onClick={() => switchEditorWorkflow(item.id)}>{item.icon}<span>{item.name}</span>{editorWorkflow === item.id && workflowIsCustom && <i>已改</i>}</button>)}</aside><div className={`workflow-editor-main ${workflowJsonCollapsed ? "json-collapsed" : ""}`}><div className="comfy-frame-wrap">{backendUrl ? <webview key={comfySession} partition={comfySession} ref={comfyRef} title="ComfyUI 工作流编辑器" src={backendUrl} /> : <div className="comfy-unavailable">本地引擎尚未就绪，请稍后重试</div>}</div><div className="workflow-json-panel"><div className="workflow-json-head"><span>API 工作流 JSON</span><div><button onClick={() => setWorkflowJsonCollapsed((collapsed) => !collapsed)}>{workflowJsonCollapsed ? "展开" : "收起"}</button><button onClick={importWorkflowJson} disabled={workflowEditorBusy}>导入 JSON</button></div></div>{!workflowJsonCollapsed && <><textarea value={workflowJson} onChange={(event) => { setWorkflowJson(event.target.value); setWorkflowIsCustom(false); }} spellCheck="false" placeholder="从 ComfyUI 使用“Save (API Format)”导出后导入" /><small>仅支持 ComfyUI API 格式；普通界面工作流 JSON 不能直接用于生成。</small></>}</div></div></div><footer className="workflow-modal-footer"><span className={workflowEditorStatus.includes("失败") || workflowEditorStatus.includes("不正确") ? "error" : ""}>{workflowEditorStatus}</span><div><button className="ghost-button" onClick={resetEditorWorkflow} disabled={workflowEditorBusy}>恢复默认</button><button className="primary-button" onClick={saveEditorWorkflow} disabled={workflowEditorBusy || !workflowJson.trim()}>应用到当前模式</button></div></footer></section></div>}
    {workflowEditorOpen && workflowBackups.length > 0 && <div className="workflow-backups-float"><div><strong>历史版本</strong><button onClick={() => loadWorkflowBackups(editorWorkflow)}>刷新</button></div>{workflowBackups.slice(0, 5).map((backup) => <button key={backup.id} onClick={() => restoreWorkflowBackup(backup)}><span>{backup.name.replace(`${editorWorkflow}.`, "").replace(/\.json$/, "")}</span><small>恢复</small></button>)}</div>}
    {queueDetailJob && <div className="overlay-backdrop" role="dialog" aria-modal="true" onClick={() => setQueueDetailJob(null)}><section className="overlay-modal queue-detail-modal" onClick={(event) => event.stopPropagation()}><div className="overlay-head"><div><h2>{queueDetailJob.workflowName}</h2><p>{queueStateLabel(queueDetailJob.state)} · {queueTime(queueDetailJob.createdAt)}</p></div><button className="menu-close" onClick={() => setQueueDetailJob(null)}>×</button></div><div className="queue-detail-grid"><div><span>提示词</span><p>{queueDetailJob.originalPrompt || queueDetailJob.prompt || "未填写提示词"}</p></div><div><span>参数</span><p>{queueDetailJob.settings?.aspectRatio || "默认画幅"} · {resolutionDisplay(queueDetailJob.settings?.resolution, queueDetailJob.settings?.aspectRatio)} · {queueDetailJob.settings?.duration || 5} 秒 · 24 fps · {({ quality: "标准质量", turbo4: "四步加速", turbo8: "八步均衡" })[queueDetailJob.settings?.samplingMode] || "标准质量"}{queueDetailJob.settings?.style ? ` · ${generationStyles.find(item => item.id === queueDetailJob.settings.style)?.name || queueDetailJob.settings.style}` : ""}</p></div><div><span>参考素材</span><div className="queue-detail-previews">{(queueDetailJob.mediaPreviews || []).map((url) => /\.(mp4|mov|mkv|webm|avi)$/i.test(url) ? <video key={url} src={url} controls preload="metadata" /> : <img key={url} src={url} alt="" />)}</div></div>{queueDetailJob.error && <div className="queue-error">{queueDetailJob.error}</div>}</div></section></div>}
    {assetLibraryOpen && <div className="overlay-backdrop" role="dialog" aria-modal="true" onClick={() => setAssetLibraryOpen(false)}><section className="overlay-modal asset-library-modal" onClick={(event) => event.stopPropagation()}><div className="overlay-head"><div><h2>素材库</h2><p>已添加过的图片会自动保存在这里</p></div><div className="asset-library-head-actions">{assetLibrary.length > 0 && <button className="cutout-text-button" onClick={clearAssetLibrary}>清空</button>}<button className="menu-close" onClick={() => setAssetLibraryOpen(false)}>×</button></div></div>{assetLibrary.length ? <div className="asset-library-grid">{assetLibrary.map((asset) => <article className="asset-library-item" key={asset.id}><button onClick={() => useLibraryAsset(asset)}><img src={asset.fileUrl || ""} onError={(event) => { event.currentTarget.style.opacity = .28; }} alt="" /><span>{asset.name}</span></button><button className="asset-library-delete" onClick={() => removeLibraryAsset(asset.id)}>×</button></article>)}</div> : <div className="overlay-empty">素材库还是空的</div>}</section></div>}
    {previewVideo && <div className="overlay-backdrop video-preview-backdrop" role="dialog" aria-modal="true" aria-label="视频预览" onClick={() => setPreviewVideo(null)}><section className="overlay-modal video-preview-modal" onClick={(event) => event.stopPropagation()}><div className="overlay-head"><div><h2>视频预览</h2><p>{previewVideo.name}</p></div><button className="menu-close" onClick={() => setPreviewVideo(null)} aria-label="关闭视频预览">×</button></div><div className="video-preview-player" data-aspect={videoAspectClass(previewVideo)}><video src={previewVideo.url} controls autoPlay playsInline muted={audioMuted} onLoadedMetadata={syncVideoNativeAspect} /></div><div className="video-preview-meta">{previewVideo.aspectRatio || "默认画幅"} · {previewVideo.resolution || "默认分辨率"} · {previewVideo.duration || 5} 秒 · {previewVideo.fps || 24} fps</div></section></div>}
    {integrationOpen && <IntegrationSettings onClose={() => setIntegrationOpen(false)} />}
    {healthOpen && <div className="overlay-backdrop" role="dialog" aria-modal="true" onClick={() => setHealthOpen(false)}><section className="overlay-modal settings-modal" onClick={(event) => event.stopPropagation()}><div className="overlay-head"><div><h2>引擎自检</h2><p>检查 ComfyUI、Python、工作流和运行状态</p></div><button className="menu-close" onClick={() => setHealthOpen(false)}>×</button></div>{healthState.loading ? <div className="overlay-loading">正在检查...</div> : healthState.data ? <div className="health-list">{Object.entries(healthState.data.checks || {}).map(([key, value]) => <div key={key}><span>{({ python: "Python", comfyui: "ComfyUI", workflows: "工作流", output: "输出目录", dependencies: "引擎依赖版本", models: "模型文件" })[key] || key}</span><b className={value ? "ok" : "bad"}>{value ? "正常" : "异常"}</b></div>)}<div><span>后端服务</span><b className={healthState.data.backendReady ? "ok" : "bad"}>{healthState.data.backendReady ? "已连接" : "未连接"}</b></div><div><span>参考图节点</span><b className={healthState.data.referenceNode ? "ok" : "bad"}>{healthState.data.referenceNode ? "支持" : "未检测到"}</b></div><div><span>运行平台</span><b className={healthState.data.platform?.supported ? "ok" : "bad"}>{healthState.data.platform?.supported ? `${healthState.data.platform.name} ${healthState.data.platform.arch}` : "仅支持 Windows x64"}</b></div><div><span>显卡</span><b className={healthState.data.gpu?.supported ? "ok" : "bad"}>{healthState.data.gpu?.supported ? healthState.data.gpu.name : (healthState.data.gpu?.available ? "需要 NVIDIA CUDA" : "未检测到")}</b></div>{healthState.data.pythonVersion && <small>Python 版本：{healthState.data.pythonVersion}</small>}<small>{healthState.data.error || "检查完成"}</small><small title={healthState.data.runtimeRoot}>运行目录：{healthState.data.runtimeRoot}</small></div> : <div className="overlay-empty">{healthState.error || "暂无结果"}</div>}<div className="overlay-footer"><button className="ghost-button" onClick={runHealthCheck}>重新检查</button><button className="primary-button" onClick={() => setHealthOpen(false)}>完成</button></div></section></div>}
    {storageOpen && <div className="overlay-backdrop" role="dialog" aria-modal="true" onClick={() => setStorageOpen(false)}><section className="overlay-modal settings-modal" onClick={(event) => event.stopPropagation()}><div className="overlay-head"><div><h2>存储占用</h2><p>只读查看当前各目录占用，不会自动删除模型</p></div><button className="menu-close" onClick={() => setStorageOpen(false)}>×</button></div>{storageState.loading ? <div className="overlay-loading">正在统计...</div> : storageState.data ? <div className="storage-list">{storageState.data.items.map((item) => <div key={item.name}><div><strong>{item.name}</strong><small>{formatSize(item.bytes)}</small></div><button onClick={() => window.studio.openDirectory(item.name === "生成视频" ? "output" : item.name === "模型文件" ? "models" : item.name === "运行日志" ? "logs" : item.name === "队列输入" ? "queue-input" : "user")}>打开</button></div>)}</div> : <div className="overlay-empty">{storageState.error || "暂无结果"}</div>}<div className="overlay-footer"><button className="ghost-button" onClick={loadStorageUsage}>刷新</button><button className="primary-button" onClick={() => setStorageOpen(false)}>完成</button></div></section></div>}
    {assetPreview && <div className="asset-preview-backdrop" role="dialog" aria-modal="true" onClick={() => setAssetPreview(null)}><div className={`asset-preview-modal ${assetPreview.kind === "cutout" || assetPreview.kind === "cutout-source" ? "cutout-preview-modal" : ""}`} onClick={(event) => event.stopPropagation()}><button className="menu-close" onClick={() => setAssetPreview(null)} aria-label="关闭预览">×</button>{assetPreview.kind === "cutout" && assetPreview.sourceUrl ? <div className="cutout-compare"><div><span>原图</span><img src={assetPreview.sourceUrl} alt="原图" /></div><div><span>抠图结果</span><img src={assetPreview.fileUrl} alt="抠图结果" /></div></div> : <img src={assetPreview.fileUrl || assetPreview.thumbnailUrl} alt={assetPreview.displayName || assetPreview.filePath || "参考图片预览"} />}<strong>{assetPreview.kind === "cutout" || assetPreview.kind === "cutout-source" ? assetPreview.displayName : `@${assetDisplayName(assetPreview, referenceAssets)}`}</strong></div></div>}
  </div>;
}

async function startStudio() {
  if (window.studio?.loadPreferences) {
    const legacy = Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("minimax-h3-")).map((key) => [key, localStorage.getItem(key)]));
    const result = await window.studio.loadPreferences(legacy);
    if (result?.ok === false) throw new Error(result.error);
    if (result?.values) {
      for (const key of Object.keys(legacy)) localStorage.removeItem(key);
      for (const [key, value] of Object.entries(result.values)) localStorage.setItem(key, value);
    }
  }
  createRoot(document.getElementById("root")).render(<App />);
}
startStudio().catch((error) => {
  const message = document.createElement("p");
  message.style.cssText = "padding:32px;line-height:1.8";
  message.textContent = `启动失败：${error.message}。请检查 App/user 中的配置文件，原配置未被覆盖。`;
  document.getElementById("root").replaceChildren(message);
});
