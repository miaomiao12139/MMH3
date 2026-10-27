import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AudioLines, ArrowDownToLine, FolderOpen, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import "./voice.css";

const DRAFT_KEY = "minimax-h3-voice-draft-v1";
const EXAMPLES = ["你好，欢迎来到 H3 Studio。让文字拥有声音，让创作更加生动。", "我最近在学习 machine learning，希望用 artificial intelligence 创造有趣的作品。"];
const seconds = value => `${Number(value || 0).toFixed(1)} 秒`;

export default function VoiceWorkspace({ active }) {
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [engine, setEngine] = useState("kokoro");
  const [voice, setVoice] = useState("zf_001");
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [health, setHealth] = useState(null);
  const [status, setStatus] = useState("输入文字，开始生成你的第一段语音。");
  const [error, setError] = useState(false);
  const [items, setItems] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [playingPath, setPlayingPath] = useState("");
  const [restored, setRestored] = useState(false);
  const pending = useRef(false);
  const draftLoaded = useRef(false);
  const player = useRef(null);
  const playbackRequest = useRef(0);
  const count = Array.from(text).length;
  const selected = items.find(item => item.path === selectedPath) || items[0];
  const selectedEngine = health?.engines?.find(item => item.id === engine);
  const voiceLabel = selectedEngine?.voices.find(item => item.id === voice)?.label || voice;

  async function refresh() {
    const [state, history] = await Promise.all([window.studio.getVoiceState(), window.studio.listVoices()]);
    setHealth(state); setBusy(Boolean(state.busy)); setItems(history);
    if (!state.ready) { setError(true); setStatus(state.error); }
  }
  useEffect(() => {
    if (!active || !window.studio?.getVoiceState) return;
    refresh().catch(e => { setError(true); setStatus(e.message); });
    if (!draftLoaded.current) {
      draftLoaded.current = true;
      window.studio.loadPreferences().then(result => {
        const draft = JSON.parse(result?.values?.[DRAFT_KEY] || "{}");
        if (typeof draft.text === "string") setText(draft.text.slice(0, 6000));
        if (Number.isFinite(draft.speed) && draft.speed >= 0.5 && draft.speed <= 2) setSpeed(draft.speed);
        if (["kokoro", "melo"].includes(draft.engine)) setEngine(draft.engine);
        if (typeof draft.voice === "string") setVoice(draft.voice);
      }).catch(console.error).finally(() => setRestored(true));
    }
  }, [active]);
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => { window.studio.savePreference(DRAFT_KEY, JSON.stringify({ text, speed, engine, voice })).catch(console.error); }, 400);
    return () => clearTimeout(timer);
  }, [text, speed, engine, voice, restored]);
  useEffect(() => {
    if (selectedEngine?.voices.length && !selectedEngine.voices.some(item => item.id === voice)) setVoice(selectedEngine.voices[0].id);
  }, [selectedEngine, voice]);
  useEffect(() => window.studio?.onVoiceProgress?.(event => {
    setBusy(Boolean(event.busy));
    if (event.message) { setError(false); setStatus(event.message); }
  }), []);
  useEffect(() => { if (!active) player.current?.pause(); }, [active]);

  async function preview(item) {
    const audio = player.current;
    if (!audio) return;
    const request = ++playbackRequest.current;
    if (audio.dataset.voicePath === item.path && !audio.paused && !audio.ended) {
      audio.pause();
      return;
    }
    // Commit the selected source before play(), while the click still grants
    // playback permission. All rows share this one player, so voices cannot overlap.
    flushSync(() => setSelectedPath(item.path));
    try { await audio.play(); }
    catch (e) {
      if (request !== playbackRequest.current || e.name === "AbortError") return;
      setPlayingPath(""); setError(true); setStatus("音频无法播放，请检查文件是否已被移动或删除。");
    }
  }

  async function generate() {
    if (pending.current || busy || clearing) return;
    pending.current = true; setBusy(true); setError(false); setStatus("正在准备语音生成…");
    try {
      const result = await window.studio.generateVoice({ text, speed, engine, voice });
      if (!result.ok) throw new Error(result.error || "生成失败");
      await refresh(); setSelectedPath(result.item.path);
      setStatus(`生成完成 · 音频 ${seconds(result.item.duration)} · 用时 ${seconds(result.item.elapsed)}`);
    } catch (e) { setError(true); setStatus(e.message); }
    finally { setBusy(false); pending.current = false; }
  }
  async function action(fn) {
    try { const result = await fn(); if (result?.ok === false && !result.canceled) throw new Error(result.error); }
    catch (e) { setError(true); setStatus(e.message); }
  }
  async function remove(item) {
    if (!window.confirm("删除这段生成的语音及其记录？")) return;
    await action(async () => { const result = await window.studio.deleteVoice(item.path); if (result.ok) await refresh(); return result; });
  }
  async function clearAll() {
    if (busy || clearing || pending.current) return;
    if (!window.confirm("清空全部语音？这会永久删除音频文件夹中所有已生成的语音及记录（包括未显示的较早记录），已导出到其他位置的文件不受影响。")) return;
    setClearing(true);
    player.current?.pause();
    player.current?.removeAttribute("src");
    player.current?.load();
    setPlayingPath("");
    try {
      const result = await window.studio.clearVoices();
      await refresh();
      setSelectedPath("");
      if (!result.ok) throw new Error(result.error || "清空失败，请重试");
      setError(false); setStatus(`已清空全部语音，共删除 ${result.deleted} 段。`);
    } catch (e) { setError(true); setStatus(e.message); }
    finally { setClearing(false); }
  }

  return <div className="voice-page" hidden={!active}>
    <div className="voice-workbench">
      <section className="voice-composer" aria-label="语音文本">
        <div className="voice-section-head"><h2>要朗读的文字</h2><span className={count > 3000 ? "voice-limit-error" : ""}>{count} / 3000</span></div>
        <textarea aria-label="要朗读的文字" value={text} onChange={e => setText(e.target.value)} placeholder="输入中文或中英混合文字，为旁白、解说和创意作品生成语音…" disabled={busy} spellCheck="false" />
        <div className="voice-examples"><span>试试</span>{EXAMPLES.map((value, index) => <button key={index} disabled={busy} onClick={() => setText(value)}>{index ? "中英混读" : "中文旁白"}</button>)}</div>
        <div className="voice-model-settings">
          <label>语音模型<select aria-label="语音模型" value={engine} disabled={busy} onChange={e => { setEngine(e.target.value); setVoice(e.target.value === "melo" ? "ZH" : "zf_001"); }}>{(health?.engines || [{ id: "kokoro", label: "Kokoro-82M-v1.1-zh" }, { id: "melo", label: "MeloTTS 中文" }]).map(item => <option key={item.id} value={item.id}>{item.label}{item.ready === false ? "（未就绪）" : ""}</option>)}</select></label>
          <label>音色<select aria-label="音色" value={voice} disabled={busy || !selectedEngine?.ready} onChange={e => setVoice(e.target.value)}>{selectedEngine?.voices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        </div>
        <div className="voice-settings"><label>语速 <strong>{Number(speed).toFixed(2)}×</strong><input aria-label="语速" type="range" min="0.5" max="2" step="0.05" value={speed} disabled={busy} onChange={e => setSpeed(Number(e.target.value))} /></label><button className="voice-subtle-button" disabled={busy} onClick={() => setSpeed(1)}><RotateCcw size={13} />恢复正常</button></div>
        <div className="voice-composer-footer"><span>{voiceLabel} · {engine === "kokoro" && !voice.startsWith("z") ? "英文朗读" : "支持中英混读"}</span><button className="voice-generate" onClick={generate} disabled={busy || clearing || !selectedEngine?.ready || !selectedEngine?.voices.some(item => item.id === voice) || !/[\p{L}\p{N}]/u.test(text) || count > 3000}><AudioLines size={16} />{busy ? "正在生成…" : "生成语音"}</button></div>
      </section>
      <section className="voice-listen" aria-label="语音试听">
        <div className="voice-section-head"><h2>语音试听</h2><span className="voice-local-badge">本地离线</span></div>
        <div className={`voice-player-art ${busy ? "is-working" : ""}`}><AudioLines size={48} strokeWidth={1.1} /><strong>{busy ? "正在创作声音" : selected ? "你的声音，准备好了" : "让文字拥有声音"}</strong><span>{selected ? `${seconds(selected.duration)} · WAV · ${selected.sampleRate / 1000} kHz` : `${selectedEngine?.label || "Kokoro"} · ${voiceLabel}`}</span></div>
        <audio ref={player} controls preload="metadata" src={selected?.url || undefined} data-voice-path={selected?.path || ""} aria-label="生成语音播放器"
          onPlay={event => { if (!event.currentTarget.paused) setPlayingPath(event.currentTarget.dataset.voicePath); }}
          onPause={event => { if (event.currentTarget.paused) setPlayingPath(""); }}
          onEnded={() => setPlayingPath("")} onError={() => setPlayingPath("")} />
        <div className="voice-player-actions"><button disabled={!selected} onClick={() => action(() => window.studio.exportVoice(selected.path))}><ArrowDownToLine size={15} />导出 WAV</button><button onClick={() => action(() => window.studio.openVoiceFolder())}><FolderOpen size={15} />音频文件夹</button></div>
      </section>
    </div>
    <div className={`voice-feedback ${error ? "is-error" : ""}`} role="status"><span>{busy && <i className="voice-spinner" />}{status}</span>{busy && <button onClick={() => action(() => window.studio.cancelVoice())}><Square size={12} />停止生成</button>}</div>
    <section className="voice-history" aria-label="最近语音">
      <div className="voice-section-head"><h2>最近语音 <small>{items.length}</small></h2><div className="voice-history-actions"><button className="voice-subtle-button voice-clear-all" disabled={busy || clearing || !items.length} onClick={clearAll}><Trash2 size={13} />{clearing ? "正在清空…" : "清空全部"}</button><button className="voice-subtle-button" disabled={clearing} onClick={() => refresh().catch(e => { setError(true); setStatus(e.message); })}>刷新记录</button></div></div>
      {items.length ? <div className="voice-history-list">{items.map(item => <article key={item.path} className={`voice-history-item ${selected?.path === item.path ? "is-selected" : ""}`}>
        <button className="voice-select" aria-label={`${playingPath === item.path ? "暂停" : "试听"} ${item.name}`} aria-pressed={playingPath === item.path} title={playingPath === item.path ? "暂停试听" : "播放试听"} onClick={() => preview(item)}>{playingPath === item.path ? <Pause size={15} /> : <Play size={15} />}</button>
        <div className="voice-history-copy"><strong title={item.text || item.name}>{item.text || item.name}</strong><span>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} · {item.duration ? seconds(item.duration) : "WAV"} · {item.speed}× · {item.voice === "ZH" ? "MeloTTS" : item.voice}</span></div>
        <button className="voice-subtle-button" onClick={() => { setText(item.text); setSpeed(item.speed); setEngine(item.engine); setVoice(item.voice); }} disabled={busy || !item.text}>复用文本</button>
        <button className="voice-icon-button" title="导出 WAV" onClick={() => action(() => window.studio.exportVoice(item.path))}><ArrowDownToLine size={16} /></button>
        <button className="voice-icon-button" title="打开文件位置" onClick={() => action(() => window.studio.revealVoice(item.path))}><FolderOpen size={16} /></button>
        <button className="voice-icon-button voice-delete" title="删除语音" onClick={() => remove(item)}><Trash2 size={15} /></button>
      </article>)}</div> : <div className="voice-history-empty">生成的语音会保存在这里，也可以随时导出 WAV 文件。</div>}
    </section>
  </div>;
}
