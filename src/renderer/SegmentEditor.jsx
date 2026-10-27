import React, { useEffect, useRef, useState } from "react";

const modes = [
  ["point", "选中对象"], ["negative", "排除对象"], ["box", "框选对象"],
  ["paint", "保留画笔"], ["erase", "擦除画笔"], ["automatic", "自动去背景"],
];

export default function SegmentEditor({ src, value, onChange, busy, result }) {
  const [mode, setMode] = useState("point");
  const [size, setSize] = useState(null);
  const [brush, setBrush] = useState(3);
  const [showResult, setShowResult] = useState(false);
  const [undo, setUndo] = useState([]);
  const gesture = useRef(null);
  const current = useRef(value);
  current.current = value;
  useEffect(() => { setShowResult(Boolean(result)); }, [result]);
  const update = next => { current.current = next; onChange(next); setShowResult(false); };
  const position = e => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const down = e => {
    if (busy || !size || mode === "automatic" || showResult || e.button !== 0) return;
    e.preventDefault();
    const p = position(e);
    const before = current.current;
    setUndo(items => [...items, before].slice(-100));
    gesture.current = { start: p, before };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (mode === "point" || mode === "negative") update({ ...before, points: [...before.points, { ...p, label: mode === "point" ? 1 : 0 }] });
    else if (mode === "box") update({ ...before, box: { ...p, width: 0, height: 0 } });
    else update({ ...before, strokes: [...before.strokes, { points: [p], radius: brush / 100, label: mode === "paint" ? 1 : 0 }] });
  };
  const move = e => {
    if (!gesture.current || busy) return;
    const p = position(e);
    const previous = current.current;
    if (mode === "box") {
      const s = gesture.current.start;
      update({ ...previous, box: { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(s.x - p.x), height: Math.abs(s.y - p.y) } });
    } else if (mode === "paint" || mode === "erase") {
      const strokes = [...previous.strokes];
      const stroke = strokes[strokes.length - 1];
      if (stroke.points.length >= 1000) return;
      const last = stroke.points[stroke.points.length - 1];
      if (Math.hypot(last.x - p.x, last.y - p.y) < .002) return;
      strokes[strokes.length - 1] = { ...stroke, points: [...stroke.points, p] };
      update({ ...previous, strokes });
    }
  };
  const end = e => {
    if (!gesture.current) return;
    if (mode === "box" && (current.current.box.width < .003 || current.current.box.height < .003)) update(gesture.current.before);
    gesture.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const abort = () => {
    if (gesture.current) { update(gesture.current.before); setUndo(items => items.slice(0, -1)); }
    gesture.current = null;
  };
  const width = size?.width || 1, height = size?.height || 1;
  return <div className="ai-segment-editor">
    <div className="ai-segment-modes" role="group" aria-label="抠图选择工具">{modes.map(([id, title]) => <button key={id} disabled={busy} aria-pressed={mode === id} onClick={() => { setMode(id); update({ ...current.current, automatic: id === "automatic" }); }}>{title}</button>)}</div>
    <div className="ai-segment-controls">
      {(mode === "paint" || mode === "erase") && <label>画笔大小<input aria-label="画笔大小" disabled={busy} type="range" min="0.2" max="12" step="0.2" value={brush} onChange={e => setBrush(Number(e.target.value))} /><span>{brush}%</span></label>}
      <button disabled={busy || !undo.length} onClick={() => { update({ ...undo[undo.length - 1], automatic: mode === "automatic" }); setUndo(items => items.slice(0, -1)); }}>撤销</button>
      <button disabled={busy} onClick={() => { setUndo(items => [...items, current.current]); update({ points: [], strokes: [], box: null, automatic: mode === "automatic" }); }}>清空选区</button>
      {result && <button disabled={busy} aria-pressed={showResult} onClick={() => setShowResult(v => !v)}>{showResult ? "返回编辑" : "查看透明结果"}</button>}
    </div>
    <p className="ai-segment-help">{mode === "automatic" ? "自动识别整张图片中的前景。" : mode === "box" ? "拖动框住目标，保留原图尺寸；可继续添加选中点和排除点。" : mode === "paint" || mode === "erase" ? "在原图上涂画：绿色保留，红色擦除。画笔会直接修正结果边缘。" : "点击想保留的对象；切换“排除对象”点击不需要的部分。绿色为保留，红色为排除。"}</p>
    <div className={`ai-selection-stage ${showResult ? "show-result" : ""}`}>
      <div className="ai-selection-image" style={{ width: size ? `min(100%, calc(var(--segment-canvas-height, 520px) * ${width / height}))` : undefined }} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={abort} onLostPointerCapture={abort}>
        <img src={showResult && result ? result : src} alt={showResult ? "透明抠图结果" : "待抠图图片"} draggable="false" onLoad={e => { if (!showResult) { const s = { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }; setSize(s); } }} />
        {!showResult && mode !== "automatic" && <svg className="ai-segment-overlay" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {value.box && <rect x={value.box.x * width} y={value.box.y * height} width={value.box.width * width} height={value.box.height * height} fill="#38c98b22" stroke="#38c98b" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          {value.strokes.map((s, i) => s.points.length === 1
            ? <circle key={i} cx={s.points[0].x * width} cy={s.points[0].y * height} r={s.radius * Math.min(width, height)} fill={s.label ? "#38c98b99" : "#ef646499"} />
            : <polyline key={i} points={s.points.map(p => `${p.x * width},${p.y * height}`).join(" ")} stroke={s.label ? "#38c98b99" : "#ef646499"} strokeWidth={s.radius * Math.min(width, height) * 2} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
          {value.points.map((p, i) => <g key={i} transform={`translate(${p.x * width},${p.y * height})`}><circle r={Math.min(width, height) * .015} fill={p.label ? "#38c98b" : "#ef6464"} stroke="white" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></g>)}
        </svg>}
      </div>
    </div>
    <small className="ai-segment-summary">{value.points.length} 个点击 · {value.strokes.length} 条笔画{value.box ? " · 已框选" : ""} · 修改后点击“更新抠图”查看结果</small>
  </div>;
}
