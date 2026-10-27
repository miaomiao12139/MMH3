import React, { useEffect, useMemo, useRef, useState } from "react";
import { assetDisplayName } from "./referencePromptParser.mjs";

export default function ReferenceAssetsPanel({ assets, limit = 9, dragging, disabled, onChoose, onDrop, onRemove, onPreview, onReorder, onDragStateChange, onOpenLibrary }) {
  const [dragAssetId, setDragAssetId] = useState("");
  const [unavailableIds, setUnavailableIds] = useState(() => new Set());
  const lastReorderTarget = useRef("");
  const visibleAssets = useMemo(() => assets.slice(0, limit), [assets, limit]);

  useEffect(() => {
    const currentIds = new Set(assets.map((asset) => String(asset.id)));
    setUnavailableIds((old) => {
      const next = new Set([...old].filter((id) => currentIds.has(id)));
      return next.size === old.size ? old : next;
    });
  }, [assets]);

  return <section className="media-section reference-assets-section">
    <div className="section-heading"><div><span>参考图片</span><em>{assets.length} / {limit}</em></div>{onOpenLibrary && <button className="section-link-button" type="button" onClick={onOpenLibrary}>素材库</button>}</div>
    <div
      className={`reference-assets-grid ${dragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); onDragStateChange?.(true); }}
      onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; onDragStateChange?.(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) onDragStateChange?.(false); }}
      onDrop={(event) => { onDragStateChange?.(false); onDrop?.(event); }}
    >
      {visibleAssets.map((asset, index) => <article
        className={`reference-asset-card ${dragAssetId === asset.id ? "is-reordering" : ""}`}
        key={asset.id}
        draggable={!disabled}
        onDragStart={(event) => { setDragAssetId(asset.id); lastReorderTarget.current = ""; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/reference-asset-id", asset.id); }}
        onDragEnd={() => { setDragAssetId(""); lastReorderTarget.current = ""; }}
        onDragOver={(event) => { event.preventDefault(); if (dragAssetId && dragAssetId !== asset.id && lastReorderTarget.current !== asset.id) { lastReorderTarget.current = asset.id; onReorder(dragAssetId, asset.id); } }}
      >
        <button className={`reference-asset-preview ${unavailableIds.has(String(asset.id)) ? "is-unavailable" : ""}`} type="button" onClick={() => onPreview(asset)} title={unavailableIds.has(String(asset.id)) ? "文件不可用，可重新选择或移除" : "预览图片"}>
          {unavailableIds.has(String(asset.id)) ? <span className="reference-asset-unavailable"><strong>文件不可用</strong><small>请重新选择或移除</small></span> : <img src={asset.thumbnailUrl || asset.fileUrl} onError={() => setUnavailableIds((old) => new Set(old).add(String(asset.id)))} alt={assetDisplayName(asset, assets)} />}
          <span className="reference-asset-type">图片</span>
        </button>
        <div className="reference-asset-footer"><strong>@{assetDisplayName(asset, assets)}</strong><button type="button" className="reference-asset-remove" onClick={() => onRemove(asset.id)} disabled={disabled} aria-label={`删除${assetDisplayName(asset, assets)}`}>×</button></div>
      </article>)}
      {assets.length < limit && <button className="reference-asset-add" type="button" onClick={onChoose} disabled={disabled}>
        <span>＋</span><b>{assets.length ? "继续添加" : "添加参考图片"}</b><small>PNG / JPG / WEBP</small>
      </button>}
    </div>
    <p className="upload-hint">支持拖入多张图片，可拖动卡片调整顺序</p>
  </section>;
}
