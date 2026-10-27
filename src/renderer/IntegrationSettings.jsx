import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import "./integration-settings.css";

const samples = {
  voice: ["语音合成", { text: "你好，欢迎使用 H3", engine: "kokoro", voice: "zf_001", speed: 1 }],
  "image-enhance": ["图片增强", { file: "D:\\素材\\图片.png" }],
  enhance: ["视频增强", { file: "D:\\素材\\视频.mp4" }],
  interpolate: ["视频补帧", { file: "D:\\素材\\视频.mp4", multiplier: 2 }],
  segment: ["点选抠图", { file: "D:\\素材\\图片.png", segmentMode: "interactive", segmentPrompts: { points: [{ x: 0.5, y: 0.5, label: 1 }], box: null, strokes: [] } }],
  automatic: ["自动抠图", { file: "D:\\素材\\图片.png", segmentMode: "automatic" }],
  understand: ["图像理解", { file: "D:\\素材\\图片.png", prompt: "请用中文描述图片" }],
  "cutout-batch": ["批量抠图", { media: ["D:\\素材\\图片1.png", "D:\\素材\\图片2.png"] }],
  video: ["文生视频", { workflow: "t2v", prompt: "一只小猫在阳光下散步", settings: { duration: 5, resolution: "standard", aspectRatio: "16:9", samplingMode: "turbo4" } }],
};
const psQuote = text => "'" + String(text).replaceAll("'", "''") + "'";

export default function IntegrationSettings({ onClose }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("cli");
  const [advanced, setAdvanced] = useState(false);
  const [sample, setSample] = useState("voice");
  const [copied, setCopied] = useState("");
  const panel = useRef(null);
  const timer = useRef(null);
  useEffect(() => {
    let disposed = false;
    const previous = document.activeElement;
    panel.current?.focus();
    Promise.resolve().then(() => window.studio.getIntegrationInfo()).then(result => {
      if (disposed) return;
      if (!result?.ok) throw new Error(result?.error || "读取接口信息失败");
      setInfo(result);
    }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; clearTimeout(timer.current); previous?.focus?.(); };
  }, []);
  async function copy(id, text) {
    clearTimeout(timer.current); setCopied("");
    try {
      const result = await window.studio.copyText(text);
      if (!result?.ok) throw new Error(result?.error || "复制失败，请选中文字手动复制");
      clearTimeout(timer.current); setCopied(id); setError("");
      timer.current = setTimeout(() => setCopied(""), 2000);
    } catch (e) { setError(e.message); }
  }
  function command(id, title, text, description) {
    return <article className="integration-command" key={id}><div className="integration-command-head"><h3>{title}</h3><button type="button" onClick={() => copy(id, text)} aria-label={`复制${title}`}>{copied === id ? <Check size={14} /> : <Copy size={14} />}{copied === id ? "已复制" : "复制"}</button></div>{description && <p>{description}</p>}<pre><code>{text}</code></pre></article>;
  }
  const kind = sample === "automatic" ? "segment" : sample;
  const sampleCommand = `'${JSON.stringify(samples[sample][1])}' | Set-Content -Encoding UTF8 h3-input.json\nh3 ${sample === "video" ? "generate" : `task ${kind}`} --input "@h3-input.json" --wait`;
  const descriptor = info ? psQuote(info.descriptorPath) : "";
  const apiSetup = `$h3 = Get-Content -LiteralPath ${descriptor} -Raw | ConvertFrom-Json\n$headers = @{ Authorization = "Bearer $($h3.token)" }`;
  const connectPrompt = `请帮我接入 H3 Studio 的全部本机功能，安装 CLI 与 Skill，执行：\n\nirm https://raw.githubusercontent.com/miaomiao12139/MMH3/2248c5e62d49a09c8ed4292f13b8f2d6a32aff46/cli/install.ps1 | iex\n\n安装后执行 h3 skill show 阅读使用说明，连接当前安装目录 ${info?.appRoot || "（我的 H3 App 目录）"}，运行 h3 doctor 验证。之后通过 H3 完成我的视频生成、语音、图片/视频增强、补帧、抠图和图像理解请求。`;
  function trapFocus(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab") return;
    const items = [...panel.current.querySelectorAll("button, select, a[href], [tabindex='0']")].filter(el => !el.disabled);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <div className="overlay-backdrop" onClick={onClose}><section className="overlay-modal integration-modal" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="integration-title" onClick={e => e.stopPropagation()} onKeyDown={trapFocus}>
    <div className="overlay-head"><div><h2 id="integration-title">CLI 与接口调用</h2><p>供其他软件和 AI 助手调用本机 H3</p></div><button className="menu-close" aria-label="关闭调用说明" onClick={onClose}>×</button></div>
    {advanced && <div className="integration-tabs" role="tablist" aria-label="调用方式">{[["cli", "命令行 CLI"], ["http", "HTTP API"]].map(([id, title]) => <button key={id} id={`integration-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="integration-content" onClick={() => setTab(id)}>{title}</button>)}</div>}
    {!advanced && <div className="integration-connect">
      <h3>一段指令，接入全部功能</h3>
      <p>复制后发给其他 AI 助手。接入完成后，直接告诉它你想做什么。</p>
      <pre>{connectPrompt}</pre>
      <button className="primary-button integration-connect-copy" disabled={!info} onClick={() => copy("connect-all", connectPrompt)}>{copied === "connect-all" ? <Check size={16} /> : <Copy size={16} />}{copied === "connect-all" ? "已复制接入指令" : "复制接入指令"}</button>
      <small>使用本机已有模型，保持 H3 打开即可，无需云账号登录。</small>
      {error && <p className="integration-error" role="alert">{error}</p>}
    </div>}
    {advanced && <>
    <div className="integration-content" id="integration-content" role="tabpanel" aria-labelledby={`integration-tab-${tab}`}>
      <p className="integration-note">保持 H3 打开，任务在本机执行，无需云账号登录。下方命令可直接复制；文件路径请替换为实际路径。</p>
      {error && <p className="integration-error" role="alert">{error}</p>}
      {!info ? <p className="integration-note">{error ? "关闭后重新打开可重试。" : "正在读取本机接口信息…"}</p> : tab === "cli" ? <>
        {command("install", "一键安装 CLI + Skill · PowerShell", "irm https://raw.githubusercontent.com/miaomiao12139/MMH3/2248c5e62d49a09c8ed4292f13b8f2d6a32aff46/cli/install.ps1 | iex", "安装命令行工具和 Codex Skill，使用已有 H3 模型。安装后打开新终端运行 h3。")}
        {command("bash", "一键安装 · Windows Git Bash", "curl -fsSL https://raw.githubusercontent.com/miaomiao12139/MMH3/658757ee421cabe9a5531072d7537aecb9aea78c/cli/install.sh | bash")}
        {command("login", "连接当前 H3", `h3 auth login --app-root ${psQuote(info.appRoot)}\nh3 doctor`, "已填入这台电脑的实际安装目录。")}
        {command("discover", "查询可用功能", "h3 capabilities\nh3 --help")}
        <label className="integration-example-select">调用示例<select value={sample} onChange={e => setSample(e.target.value)}>{Object.entries(samples).map(([id, [title]]) => <option key={id} value={id}>{title}</option>)}</select></label>
        {command("example-" + sample, samples[sample][0] + " · PowerShell", sampleCommand, "先写入 UTF-8 参数文件，再提交并等待结果。点选坐标范围为 0–1；1 保留、0 排除。")}
        {command("jobs", "查看任务与输出", "h3 jobs list\nh3 outputs", "等待超时后先查询任务，避免重复提交。")}
        {command("skill", "安装到 Claude", "h3 skill install --target claude", "Codex Skill 在一键安装时已自动安装。")}
      </> : <>
        <div className="integration-connection"><span className={info.baseUrl ? "connected" : ""}>{info.baseUrl ? "本机接口已启动" : "接口尚未启动，请稍后重新打开"}</span><code>{info.baseUrl || "未连接"}</code></div>
        {command("descriptor", "连接描述文件", info.descriptorPath, "记录当前端口与凭据；重启 H3 后凭据会更新。示例每次从此文件读取，不展示或复制真实 token。")}
        {command("health", "鉴权与健康检查 · PowerShell", `${apiSetup}\nInvoke-RestMethod -Uri "$($h3.baseUrl)/api/v1/health" -Headers $headers`)}
        {command("http-task", "提交语音任务 · PowerShell", `${apiSetup}\n$body = @{ kind = "voice"; input = @{ text = "你好，欢迎使用 H3"; engine = "kokoro"; voice = "zf_001" } } | ConvertTo-Json -Depth 10\n$task = Invoke-RestMethod -Method Post -Uri "$($h3.baseUrl)/api/v1/tasks" -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))\n$task.job.id`, "返回任务 ID；其他工具的输入格式与 CLI 示例相同。")}
        {command("http-progress", "查询任务进度 · PowerShell", `${apiSetup}\n$jobId = '替换为返回的任务ID'\nInvoke-RestMethod -Uri "$($h3.baseUrl)/api/v1/tasks/$jobId" -Headers $headers`, "语音和图像工具使用 tasks；视频生成任务使用 jobs。")}
        {command("openapi", "完整接口说明", "h3 openapi", "包含视频生成、工具任务、取消和管理接口。HTTP 仅监听 127.0.0.1，使用 Bearer 鉴权。")}
      </>}
    </div></>}<div className="overlay-footer"><span className="integration-feedback" role="status" aria-live="polite">{copied ? "已复制到剪贴板" : ""}</span><button className="ghost-button" onClick={() => setAdvanced(value => !value)}>{advanced ? "返回一键接入" : "高级说明"}</button><button className="primary-button" onClick={onClose}>完成</button></div>
  </section></div>;
}
