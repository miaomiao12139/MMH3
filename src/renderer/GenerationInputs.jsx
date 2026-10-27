import React from 'react';

export default function GenerationInputs({ workflow, files, previews, settings, disabled, onChoose, onRemove, onDrop, onSettings }) {
  const frames = workflow.id === 'multiframe';
  return <section className="media-section generation-inputs">
    <div className="section-heading"><div><span>{frames ? '参考帧与时间' : workflow.id === 'continuation' ? '上一段视频' : '控制视频'}</span><em>{files.slice(0, workflow.media).filter(Boolean).length} / {workflow.media}</em></div></div>
    <p className="generation-help">{frames ? '按时间顺序添加图片，指定每张画面出现的秒数。' : workflow.id === 'continuation' ? '提取视频最后一帧生成独立新片段；原视频和原音轨需另行剪辑拼接。' : '上传动作视频自动提取姿态，或使用准备好的控制画面。'}</p>
    <div className="generation-input-grid" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
      {Array.from({ length: workflow.media }, (_, index) => <div className="generation-input-item" key={index}>
        {files[index] ? <>
          <div className="generation-media-preview">{frames ? <img src={previews[index]} alt={`参考帧 ${index + 1}`} /> : <video src={previews[index]} controls preload="metadata" />}</div>
          <small className="generation-filename" title={files[index]}>{files[index].split(/[\\/]/).pop()}</small>
          <div className="generation-input-actions"><button disabled={disabled} onClick={() => onChoose(index)}>替换</button><button disabled={disabled} onClick={e => onRemove(index, e)}>移除</button></div>
        </> : <button className="dropzone" disabled={disabled} onClick={() => onChoose(index)}><span className="upload-symbol">+</span><b>{frames ? `参考帧 ${index + 1}${index ? '（可选）' : ''}` : '选择视频'}</b><small>{frames ? 'PNG / JPG / WEBP' : 'MP4 / MOV / MKV / WEBM'}</small></button>}
        {frames && <label className="frame-time">出现时间<input aria-label={`第 ${index + 1} 帧时间`} type="number" min="0" max={settings.duration - 0.1} step="0.1" value={settings.frameTimes?.[index] ?? [0, 1.5, 3, 4.5][index]} onChange={e => { const times = [...(settings.frameTimes || [0, 1.5, 3, 4.5])]; times[index] = Number(e.target.value); onSettings({ frameTimes: times }); }} />秒</label>}
      </div>)}
    </div>
    {workflow.id === 'control' && <div className="control-settings"><label>控制方式<select value={settings.controlMode || 'pose'} onChange={e => onSettings({ controlMode: e.target.value })}><option value="pose">自动提取人物姿态</option><option value="direct">已有控制画面</option></select></label><label>控制强度<input type="number" min="0" max="2" step="0.1" value={settings.controlStrength ?? 1} onChange={e => onSettings({ controlStrength: Number(e.target.value) })} /></label></div>}
  </section>;
}
