import React, { useEffect, useMemo, useRef, useState } from "react";
import { Layers3, Play, Sparkles, Upload, X } from "lucide-react";
import "./ai-tools.css";
import SegmentEditor from "./SegmentEditor.jsx";

import { aiTools as tools } from "./aiTools.mjs";

export default function AiToolsWorkspace({ active, tool: selectedTool = "enhance" }) {
  const [state, setState] = useState({ ready: false, models: {}, missing: {} });
  const tool = selectedTool;
  const [file, setFile] = useState("");
  const [preview, setPreview] = useState("");
  const [fileName, setFileName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [multiplier, setMultiplier] = useState(2);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [segmentPrompts, setSegmentPrompts] = useState({ points: [], strokes: [], box: null, automatic: false });
  const fileInput = useRef(null);
  const toolRef = useRef(tool);
  const visit = useRef(0);
  const pending = useRef(false);
  if (toolRef.current !== tool) { toolRef.current = tool; visit.current += 1; }
  const current = useMemo(() => tools.find(item => item.id === tool), [tool]);

  useEffect(() => { window.studio?.getAiToolsState?.().then(setState).catch(cause => setError(cause.message)); const timer = setInterval(() => window.studio?.getAiToolsState?.().then(setState).catch(() => {}), 3000); return () => clearInterval(timer); }, []);
  useEffect(() => window.studio?.onAiToolProgress?.(value => setProgress(value)) || undefined, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => { setFile(""); setFileName(""); setPreview(""); setResult(null); setError(""); setSegmentPrompts({ points: [], strokes: [], box: null, automatic: false }); if (fileInput.current) fileInput.current.value = ""; }, [tool]);

  const chooseFromInput = event => {
    const selected = event.target.files?.[0]; if (!selected) return;
    const path = window.studio?.getPathForFile?.(selected) || "";
    if (busy) return;
    visit.current += 1;
    setFile(path); setFileName(selected.name); setPreview(selected.type.startsWith("image/") ? URL.createObjectURL(selected) : ""); setSegmentPrompts({ points: [], strokes: [], box: null, automatic: false }); setResult(null); setError("");
  };
  const run = async () => {
    if (pending.current) return;
    if (!file) { fileInput.current?.click(); return; }
    pending.current = true;
    const requestVisit = visit.current;
    setBusy(true); setError(""); setResult(null); setProgress({ label: "正在提交本地任务", value: 0 });
    try { const response = await window.studio?.runAiTool?.({ kind: tool, file, prompt, multiplier, segmentMode: segmentPrompts.automatic ? "automatic" : "interactive", segmentPrompts }); if (!response?.ok) throw new Error(response?.error || "处理失败"); if (visit.current === requestVisit) setResult(response); }
    catch (cause) { if (visit.current === requestVisit) setError(cause.message || "本地处理失败"); } finally { pending.current = false; setBusy(false); }
  };
  const cancel = async () => { const response = await window.studio?.cancelAiTool?.(); if (!response?.ok) setError(response?.error || "无法停止任务"); };

  return <section className={`ai-tools-page ${fileName ? "has-file" : ""}`} hidden={!active}>
    <div className={`ai-tool-layout ${tool === "segment" ? "ai-segment-layout" : ""}`}><section className="ai-tool-panel"><div className="ai-input-heading"><h2>{tool === "understand" ? "图片与问题" : "输入素材"}</h2><span>{current.accept === "video/*" ? "选择一段视频" : "选择一张图片"}</span></div>
      <label className="ai-file-drop"><input ref={fileInput} type="file" disabled={busy} accept={current.accept} onClick={event => { event.currentTarget.value = ""; }} onChange={chooseFromInput} /><span className="ai-upload-icon"><Upload size={22} /></span><strong>{fileName || "点击选择，或拖入文件"}</strong><small>{current.accept === "video/*" ? "MP4 · MOV · MKV · WEBM · AVI · 最大 1 GB" : "PNG · JPG · WEBP · AVIF · 最大 50 MB"}</small></label>
      {fileName && <div className="ai-selected-file"><span>{fileName}</span><button disabled={busy} onClick={() => { visit.current += 1; setFile(""); setFileName(""); setPreview(""); setResult(null); }} aria-label="移除文件"><X size={15} /></button></div>}
      {(tool === "enhance" || tool === "interpolate") && <div className="ai-tool-options">{tool === "interpolate" && <label>补帧倍率<select disabled={busy} value={multiplier} onChange={event => setMultiplier(Number(event.target.value))}><option value={2}>2×</option><option value={3}>3×</option><option value={4}>4×</option></select></label>}<small>{tool === "interpolate" ? `自动读取原视频帧率，输出为原帧率的 ${multiplier} 倍` : "自动保留原视频帧率"}</small></div>}
      {tool === "understand" && <label className="ai-prompt-label">想了解什么？<textarea rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="留空时自动生成详细中文描述" /></label>}

      {!state.ready && <div className="ai-tool-error">本地引擎尚未就绪，请稍后重试。</div>}
      {error && <div className="ai-tool-error">{error}</div>}
      {progress && busy && <div className="ai-progress"><span>{progress.label || "处理中"}</span><div><i style={{ width: `${Math.max(0, Math.min(100, progress.value || 0))}%` }} /></div><b>{progress.value || 0}%</b></div>}
      <div className="ai-tool-actions"><small>{state.models?.[tool] ? tool === "image-enhance" ? "4 倍放大 · PNG 输出" : tool === "segment" ? "透明 PNG · 保留原图尺寸" : "离线处理 · 文件保存在本机" : `缺少 ${current.model} 模型`}</small>{busy ? <button className="ai-run-button stop" onClick={cancel}><X size={16} />停止处理</button> : <button className="ai-run-button" disabled={!state.ready || !state.models?.[tool]} onClick={run}><Play size={16} />{file ? tool === "segment" && result ? "更新抠图" : "开始处理" : "选择文件并处理"}</button>}</div>
    </section><aside className="ai-result-panel"><div className="ai-tool-panel-head"><div><h2>{tool === "segment" && preview ? "对象选择与修边" : "处理结果"}</h2><p>{tool === "segment" && preview ? "点击或框选对象，用画笔调整边缘" : "完成后可预览结果或打开保存位置"}</p></div></div>
      {tool === "segment" && preview ? <><SegmentEditor key={preview} src={preview} value={segmentPrompts} onChange={setSegmentPrompts} busy={busy} result={result?.previewUrl} />{result?.resultPath && <><div className="ai-result-file"><strong>{result.resultPath.split(/[\\/]/).pop()}</strong></div><button className="ai-open-result" onClick={() => window.studio?.revealVideo?.(result.resultPath)}>打开结果位置</button></>}</> : result?.resultPath ? <>{result.previewUrl && <img className="ai-result-preview" src={result.previewUrl} alt="增强后的图片" />}<div className="ai-result-file"><Sparkles size={20} /><strong>{result.resultPath.split(/[\\/]/).pop()}</strong></div><button className="ai-open-result" onClick={() => window.studio?.revealVideo?.(result.resultPath)}>打开结果位置</button></> : result?.text ? <div className="ai-answer">{result.text}</div> : preview && current.accept === "image/*" ? <img className="ai-result-preview" src={preview} alt="待理解图片" /> : <div className="ai-result-empty"><Layers3 size={25} /><strong>{busy ? "正在处理素材" : "等待你的第一份素材"}</strong><span>{busy ? "请保留当前窗口，完成后将在这里显示" : "选择文件，处理结果将在这里呈现"}</span>{!busy && !file && <button className="empty-action" onClick={() => fileInput.current?.click()}>选择{current.accept === "video/*" ? "视频" : "图片"} →</button>}</div>}
    </aside></div>
  </section>;
}
