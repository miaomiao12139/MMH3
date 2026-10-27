const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
function createIntegrationJobs({ rootDir, writeText, operations, cancel, isBusy }) {
  let jobs;
  let active = null;
  let persistenceFailure = "";
  const file = () => path.join(rootDir(), "user", "integration-jobs.json");
  function load() {
    if (jobs) return;
    try { const parsed = JSON.parse(fs.readFileSync(file(), "utf8")); if (!Array.isArray(parsed) || parsed.some(j => !j || typeof j.id !== "string")) throw new Error("invalid job list"); jobs = parsed; }
    catch (e) { if (e.code !== "ENOENT") throw new Error(`集成任务记录损坏，原文件已保留：${e.message}`); jobs = []; }
    for (const j of jobs) if (["queued", "running", "cancelling"].includes(j.state)) { j.state = "interrupted"; j.error = "H3 已重新启动，请检查输出后重新提交"; }
  }
  function save() { fs.mkdirSync(path.dirname(file()), { recursive: true }); writeText(file(), JSON.stringify(jobs, null, 2)); }
  function snapshot(j) { return j ? JSON.parse(JSON.stringify(j)) : null; }
  function submit(kind, payload, key = "") {
    load();
    if (persistenceFailure) throw new Error(persistenceFailure);
    if (!Object.hasOwn(operations, kind)) throw new Error("未知任务类型");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("任务参数必须为 JSON 对象");
    if (key.length > 128) throw new Error("Idempotency-Key 最多 128 字符");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({kind,payload})).digest("hex");
    const previous = key && jobs.find(j => j.requestKey === key);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("同一 Idempotency-Key 不能提交不同任务"); return snapshot(previous); }
    if (active || isBusy()) throw new Error("本地引擎正忙，请等待当前任务完成");
    const job = { id: "api-" + crypto.randomUUID(), kind, state: "queued", createdAt: Date.now(), requestKey: key, fingerprint, progress: null };
    const retained = jobs;
    jobs = [...jobs.slice(-499), job];
    try { save(); } catch (e) { jobs = retained; throw e; }
    active = job;
    // Reserve the GPU synchronously; start the service before accepting another HTTP call.
    void (async () => {
      try {
        job.state = "running"; job.startedAt = Date.now(); save();
        const result = await operations[kind](payload);
        job.result = result;
        if (result?.ok === false) throw new Error(result.error || (result.canceled ? "任务已取消" : "处理未全部完成"));
        job.state = job.cancelRequested ? "cancelled" : "completed";
      } catch (e) { job.state = job.cancelRequested ? "cancelled" : "failed"; job.error = e.message || "处理失败"; }
      finally {
        job.completedAt = Date.now();
        try { save(); } catch (e) { job.persistenceError = `任务状态保存失败：${e.message}；请检查磁盘后重启 H3`; persistenceFailure = job.persistenceError; }
        if (active === job) active = null;
      }
    })();
    return snapshot(job);
  }
  async function stop(id) {
    load();
    const job = jobs.find(j => j.id === id);
    if (!job) throw new Error("找不到任务");
    if (job !== active) throw new Error("任务当前不可取消");
    job.cancelRequested = true;
    let result;
    try { result = await cancel(job.kind); } catch (e) { delete job.cancelRequested; throw e; }
    if (result?.ok === false) { delete job.cancelRequested; throw new Error(result.error || "取消失败"); }
    job.cancelRequested = true;
    return snapshot(job);
  }
  return { submit, stop, list() { load(); return jobs.map(snapshot); }, get(id) { load(); return snapshot(jobs.find(j=>j.id===id)); },
    progress(channel, value) { if (active && ((active.kind === "voice" && channel === "voice-progress") || (active.kind === "cutout-batch" && channel === "cutout-progress") || (active.kind !== "voice" && active.kind !== "cutout-batch" && channel === "ai-tool-progress"))) active.progress = value; },
    get busy() { return Boolean(active); } };
}
module.exports = { createIntegrationJobs };
