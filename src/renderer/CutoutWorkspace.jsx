import React, { useEffect, useState } from "react";
import { ArrowRight, ImagePlus, Images, RefreshCw, Trash2, Upload, X } from "lucide-react";
import "./cutout.css";

const stateLabels = { queued: "等待中", running: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消" };

export default function CutoutWorkspace({ files: inputFiles, previews: inputPreviews, file, preview, history = [], recentResults, dragging, busy, engineReady, status, cutoutOptions = {}, cutoutBatch, selectedIndex = -1, onSelect, onChoose, onRemove, onDrop, onDragChange, onOpenLibrary, onRun, onPreview, onRefresh, onOpen, onDelete, onClear, onClearInputs, onMove, onCancel, onExportBatch, onSetOptions }) {
  const files = Array.isArray(inputFiles) && inputFiles.length ? inputFiles : (file ? [file] : []);
  const previews = Array.isArray(inputPreviews) && inputPreviews.length ? inputPreviews : (preview ? [preview] : []);
  const [brokenImages, setBrokenImages] = useState(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [dragIndex, setDragIndex] = useState(-1);
  const imageKeys = files.map((item, index) => `${item}\n${previews[index] || ""}`);
  useEffect(() => {
    setBrokenImages((old) => {
      const next = new Set([...old].filter((key) => imageKeys.includes(key)));
      return next.size === old.size ? old : next;
    });
  }, [files, previews]);
  const errorStatus = /失败|错误|未连接|未就绪|找不到|不支持/.test(status);
  const completedCount = cutoutBatch?.items?.filter((item) => item?.state === "completed").length || 0;
  const failedCount = cutoutBatch?.items?.filter((item) => ["failed", "cancelled"].includes(item?.state)).length || 0;

  const refresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };
  const removeResult = async (id) => {
    setDeletingId(id);
    try { await onDelete(id); } finally { setDeletingId(""); }
  };
  const resultPreview = (item) => onPreview({ fileUrl: item.url, filePath: item.path, sourceUrl: item.sourceUrl, sourcePath: item.sourcePath, displayName: item.originalName || "透明 PNG", kind: "cutout" });
  const sourcePreview = (index) => onPreview({ fileUrl: previews[index], filePath: files[index], displayName: files[index]?.split(/[\\/]/).pop() || "图片", kind: "cutout-source" });
  const fileName = (index) => files[index]?.split(/[\\/]/).pop() || `图片 ${index + 1}`;
  const handleSortDrop = (event, targetIndex) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) {
      setDragIndex(-1);
      return;
    }
    event.stopPropagation();
    const sourceIndex = dragIndex;
    setDragIndex(-1);
    if (sourceIndex >= 0 && sourceIndex !== targetIndex) onMove?.(sourceIndex, targetIndex);
  };

  return <div className="cutout-page">
    <div className="cutout-workbench">
      <section className="cutout-pane" aria-label="待处理图片">
        <div className="cutout-pane-heading"><h2>待处理图片<span>{files.length}</span></h2><div className="cutout-heading-actions"><button className="cutout-text-button" onClick={onOpenLibrary} disabled={busy}><Images size={15} />素材库</button>{files.length > 0 && <button className="cutout-text-button cutout-clear-inputs" onClick={onClearInputs} disabled={busy}><Trash2 size={15} />清空</button>}</div></div>
        <div className={`cutout-source-frame ${dragging ? "is-dragging" : ""}`}
          onClick={(event) => { if (!busy && !event.target.closest("button, article")) onChoose(); }}
          onDragEnter={(event) => { event.preventDefault(); onDragChange(true); }}
          onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; onDragChange(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onDragChange(false); }}
          onDrop={onDrop}>
          <div className="cutout-source-grid">
            {files.map((item, index) => {
              const imageKey = imageKeys[index];
              const imageBroken = brokenImages.has(imageKey) || !previews[index];
              return <article className={`cutout-source-card ${dragIndex === index ? "is-reordering" : ""} ${selectedIndex === index ? "is-selected" : ""}`} key={`${item}-${index}`} draggable={!busy} aria-selected={selectedIndex === index} onDragStart={(event) => { setDragIndex(index); onSelect?.(index); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/cutout-index", String(index)); }} onDragEnd={() => setDragIndex(-1)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { onSelect?.(index); handleSortDrop(event, index); }}>
                <button className="cutout-source-preview" aria-label="放大原图" onFocus={() => onSelect?.(index)} onClick={() => { onSelect?.(index); if (!imageBroken) sourcePreview(index); }}>
                  {!imageBroken ? <img key={imageKey} src={previews[index]} alt={fileName(index)} onError={() => setBrokenImages((old) => new Set(old).add(imageKey))} /> : <span className="cutout-broken-image"><Images size={22} /><small>无法预览，可尝试处理</small></span>}
                </button>
                <div className="cutout-frame-tools"><button title="替换图片" aria-label="替换图片" disabled={busy} onClick={() => { onSelect?.(index); onChoose(index); }}><Upload size={15} /></button><button title="移除图片" aria-label="移除图片" disabled={busy} onClick={(event) => { onSelect?.(index); onRemove(index, event); }}><X size={15} /></button></div>
                <div className="cutout-card-caption" title={fileName(index)}>{fileName(index)}</div>
              </article>;
            })}
            {files.length > 0 && files.length < 50 && <button className="cutout-upload-tile" type="button" onClick={() => onChoose(files.length)} disabled={busy}><ImagePlus size={22} strokeWidth={1.5} /><strong>继续添加</strong><span>可一次选择多张</span></button>}
          </div>
          {!files.length && <div className="cutout-drop-hint"><ImagePlus size={30} strokeWidth={1.3} /><strong>点击添加，或拖入图片 / 文件夹</strong><span>PNG / JPG / WEBP / AVIF · 单张不超过 50 MB</span></div>}
        </div>
        <div className="cutout-pane-caption"><span>{files.length ? `已选择 ${files.length} 张图片` : "未选择图片"}</span><small>最多 50 张 · 可拖动排序</small></div>
      </section>
    </div>

    {cutoutBatch && <section className="cutout-batch-panel" aria-live="polite"><div className="cutout-batch-head"><div><strong>批量处理</strong><span>{completedCount}/{cutoutBatch.total} 张完成{failedCount ? ` · ${failedCount} 张未完成` : ""}</span></div><div className="cutout-batch-actions">{busy && <button className="cutout-cancel-button" onClick={onCancel}><X size={14} />停止处理</button>}{!busy && <button className="cutout-text-button" onClick={onClearInputs}>清空待处理</button>}</div></div></section>}

    <div className="cutout-action-bar"><span role="status" className={`cutout-feedback ${errorStatus ? "is-error" : ""}`}>{status}</span><button className="cutout-run" disabled={busy || !engineReady || !files.length} onClick={onRun}>{busy ? "处理中..." : "开始抠图"}<ArrowRight size={17} /></button></div>
    <section className="cutout-history" aria-label="最近抠图">
      <div className="cutout-pane-heading"><h2>最近抠图<span>{history.length}</span></h2><div className="cutout-history-tools"><button className="cutout-text-button" title="清空全部抠图记录" disabled={busy || refreshing || !history.length || Boolean(deletingId)} onClick={onClear}><Trash2 size={15} />清空</button><button className="cutout-tool-button" title="刷新抠图记录" aria-label="刷新抠图记录" disabled={refreshing || busy} onClick={refresh}><RefreshCw size={16} className={refreshing ? "is-spinning" : ""} /></button></div></div>
      {history.length ? <div className="cutout-history-grid">{history.map(item => <article className="cutout-history-item" key={item.id}>
        <button className="cutout-history-preview cutout-checkerboard" disabled={item.missingOutput} aria-label={`预览 ${item.originalName || "抠图结果"}`} onClick={() => resultPreview(item)}>
          {item.missingOutput ? <span className="cutout-missing-result">结果文件已移动或删除<br />可删除此记录及剩余副本</span> : <img src={item.url} alt={item.originalName || "抠图结果"} loading="lazy" />}
        </button>
        <div className="cutout-history-copy"><strong title={item.originalName}>{item.originalName || "抠图结果"}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small><div>
          <button className="cutout-open-location-button" title="打开文件位置" aria-label={`打开文件位置：${item.originalName || "抠图结果"}`} disabled={item.missingOutput} onClick={() => onOpen(item.path)}>打开文件位置</button>
          <button className="cutout-delete-button" title="删除结果" aria-label={`删除 ${item.originalName || "抠图结果"}`} disabled={busy || Boolean(deletingId)} onClick={() => removeResult(item.id)}><Trash2 size={15} /></button>
        </div></div>
      </article>)}</div> : <div className="cutout-history-empty">暂无记录</div>}
    </section>
  </div>;
}
