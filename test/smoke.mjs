import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const source = fs.readFileSync(path.join(project, "src", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(project, "src", "preload.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(project, "src", "renderer", "main.jsx"), "utf8");
const styles = fs.readFileSync(path.join(project, "src", "renderer", "styles.css"), "utf8");
const sourceWorkflowDir = path.join(project, "workflows");
const portableWorkflowDir = path.resolve(project, "..", "..", "App", "workflows");
const workflowDir = fs.existsSync(sourceWorkflowDir) ? sourceWorkflowDir : portableWorkflowDir;

assert.doesNotMatch(source, /fallbackProgress/);
assert.match(source, /nodeStep/);
assert.match(source, /nodeTotal/);
assert.match(source, /requestSingleInstanceLock/);
assert.match(source, /queue-paused/);
assert.match(source, /atomicWriteText/);
assert.match(source, /cleanupUploaded/);
assert.match(source, /verifyUpdateAsset/);
assert.match(source, /isUpdateAsset/);
assert.match(source, /process\.platform !== "win32"/);
assert.match(source, /screen\.getPrimaryDisplay/);
assert.match(preload, /removeListener\("status"/);
assert.match(preload, /removeListener\("progress"/);
assert.match(preload, /enqueue: /);
assert.match(preload, /onQueueUpdated/);
assert.match(preload, /onQueueControl/);
assert.match(preload, /isQueuePaused/);
assert.match(preload, /setAudioMuted/);
assert.match(renderer, /桌面接口未连接/);
assert.match(renderer, /setWorkflowJsonCollapsed\(true\)/);
assert.match(renderer, /comfyui-body-top,\.comfyui-body-left/);
assert.match(renderer, /onQueueUpdated/);
assert.match(renderer, /audioMuted/);
assert.match(renderer, /queueJobs\.map\(\(job, index\)/);
assert.match(renderer, /formatDuration/);
assert.match(renderer, /nodeStep/);
assert.match(renderer, /当前用时/);
assert.match(renderer, /生成用时/);
assert.doesNotMatch(renderer, /activeQueueJob/);
assert.doesNotMatch(renderer, /allowpopups/);
assert.match(source, /processQueue/);
assert.match(source, /enqueueWorkflow/);
assert.match(source, /studio-queue\.json/);
assert.match(source, /function reportProgress/);
assert.match(source, /mediaPreviews/);
assert.match(source, /progressJobId/);
assert.match(source, /jobId: job\.id/);
assert.match(styles, /queue-item/);
assert.match(styles, /queue-item-media/);
assert.match(styles, /queue-step/);
assert.match(styles, /video-thumb video::-webkit-media-controls/);

for (const name of ["MiniMax-H3-图生视频.json", "MiniMax-H3-参考生视频.json", "MiniMax-H3-文生视频.json"]) {
  const graph = JSON.parse(fs.readFileSync(path.join(workflowDir, name), "utf8"));
  const nodes = Object.values(graph);
  assert.ok(nodes.some((node) => node.class_type === "SaveVideo"), `${name}: missing SaveVideo`);
  assert.ok(nodes.some((node) => ["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"].includes(node.class_type)), `${name}: missing H3 node`);
}

console.log("smoke checks passed");
