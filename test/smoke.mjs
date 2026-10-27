import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const source = fs.readFileSync(path.join(project, "src", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(project, "src", "preload.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(project, "src", "renderer", "main.jsx"), "utf8");
const styles = fs.readFileSync(path.join(project, "src", "renderer", "styles.css"), "utf8");
const referenceAssetsPanel = fs.readFileSync(path.join(project, "src", "renderer", "ReferenceAssetsPanel.jsx"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
const { parseReferencePrompt, promptPartsToText } = await import(pathToFileURL(path.join(project, "src", "renderer", "referencePromptParser.mjs")).href);
const sourceWorkflowDir = path.join(project, "workflows");
const portableWorkflowDir = path.resolve(project, "..", "..", "App", "workflows");
const workflowDir = fs.existsSync(sourceWorkflowDir) ? sourceWorkflowDir : portableWorkflowDir;

assert.doesNotMatch(source, /fallbackProgress/);
assert.match(source, /nodeStep/);
assert.match(source, /nodeTotal/);
assert.match(source, /nodeId/);
assert.match(source, /requestSingleInstanceLock/);
assert.match(source, /queue-paused/);
assert.match(source, /atomicWriteText/);
assert.match(source, /process\.platform !== "win32"/);
assert.match(source, /cleanupUploaded/);
assert.match(source, /pruneRuntimeDatabases/);
assert.match(source, /verifyUpdateAsset/);
assert.match(source, /isUpdateAsset/);
assert.match(source, /screen\.getPrimaryDisplay/);
assert.match(preload, /removeListener\("status"/);
assert.match(preload, /removeListener\("progress"/);
assert.match(preload, /enqueue: /);
assert.match(preload, /getReferenceCapabilities/);
assert.match(preload, /getPathForFile/);
assert.match(preload, /onQueueUpdated/);
assert.match(preload, /onQueueControl/);
assert.match(preload, /isQueuePaused/);
assert.match(preload, /setAudioMuted/);
assert.match(preload, /revealVideo/);
assert.match(preload, /engineHealth/);
assert.match(preload, /storageUsage/);
assert.match(preload, /exportConfig/);
assert.match(renderer, /桌面接口未连接/);
assert.match(renderer, /setWorkflowJsonCollapsed\(true\)/);
assert.match(renderer, /comfyui-body-top,\.comfyui-body-left/);
assert.match(renderer, /onQueueUpdated/);
assert.match(renderer, /audioMuted/);
assert.match(renderer, /PROMPT_HISTORY_KEY/);
assert.match(renderer, /PROMPT_PRESETS_KEY/);
assert.match(renderer, /readPromptPresets/);
assert.match(renderer, /insertPromptPreset/);
assert.match(renderer, /deletePromptPreset/);
assert.match(renderer, /clearPromptPresets/);
assert.match(renderer, /常用预设/);
assert.match(renderer, /readPromptHistory/);
assert.match(renderer, /rememberPrompt/);
assert.match(renderer, /deletePromptHistory/);
assert.match(renderer, /clearPromptHistory/);
assert.match(renderer, /提示词历史/);
assert.match(renderer, /useState\(""\)/);
assert.doesNotMatch(renderer, /一只狗飞在天上/);
assert.match(renderer, /queueJobs\.map\(\(job, index\)/);
assert.match(renderer, /formatDuration/);
assert.match(renderer, /nodeStep/);
assert.match(renderer, /getPathForFile/);
assert.match(renderer, /__h3SetExecutionNode/);
assert.match(renderer, /function ProgressIndicator/);
assert.match(renderer, /progressPercent/);
assert.match(renderer, /progress\.indeterminate/);
assert.match(renderer, /采样/);
assert.match(renderer, /detailStepMax/);
assert.match(renderer, /function videoAspectClass/);
assert.match(renderer, /syncVideoNativeAspect/);
const thumbnail = fs.readFileSync(path.join(project, "src", "renderer", "VideoThumbnail.jsx"), "utf8");
assert.match(renderer, /import VideoThumbnail/);
assert.match(thumbnail, /canvas\.toDataURL/);
assert.match(renderer, /const \[previewVideo, setPreviewVideo\] = useState\(null\)/);
assert.match(renderer, /setPreviewVideo\(item\)/);
assert.match(renderer, /video-preview-player/);
assert.match(renderer, /aria-label="视频预览"/);
assert.doesNotMatch(renderer, /VIDEO_COVER_FRAME/);
assert.match(renderer, /fitCanvas\(comfyApp\.canvas, comfyApp, true\)/);
assert.match(renderer, /dropEffect = "copy"/);
assert.match(renderer, /Keep the current prompt and media/);
assert.match(renderer, /当前用时/);
assert.match(renderer, /生成用时/);
assert.match(renderer, /reuseQueueJob/);
assert.match(renderer, /复用输入/);
assert.doesNotMatch(renderer, /activeQueueJob/);
assert.doesNotMatch(renderer, /allowpopups/);
assert.match(source, /processQueue/);
assert.match(source, /enqueueWorkflow/);
assert.match(source, /studio-queue\.json/);
assert.match(source, /function reportProgress/);
assert.match(source, /object_info/);
assert.match(source, /inspectWorkflowRuntime/);
assert.match(source, /indeterminate/);
assert.match(source, /engine-health/);
assert.match(source, /storage-usage/);
assert.match(source, /rename-video/);
assert.match(source, /export-video/);
assert.match(source, /list-workflow-backups/);
assert.match(source, /restore-workflow-backup/);
assert.match(source, /notify/);
assert.match(source, /mediaPreviews/);
assert.match(source, /mediaPaths/);
assert.match(source, /stageReferenceAssets/);
assert.match(source, /参考生视频仅支持图片/);
assert.match(source, /progressJobId/);
assert.match(source, /jobId: job\.id/);
assert.match(styles, /queue-item/);
assert.match(styles, /queue-item-media/);
assert.match(styles, /queue-step/);
assert.match(styles, /prompt-history-panel/);
assert.match(styles, /prompt-history-delete/);
assert.match(styles, /video-thumb video::-webkit-media-controls/);
assert.match(styles, /\.video-thumb \{[^}]*aspect-ratio: 16 \/ 9/);
assert.match(styles, /object-fit: contain/);
assert.match(styles, /video-preview-layer/);
assert.match(styles, /\.video-preview-player\[data-aspect="portrait"\]/);
assert.match(styles, /\.video-preview-player\[data-aspect="square"\]/);
assert.match(referenceAssetsPanel, /文件不可用/);
assert.match(referenceAssetsPanel, /onError/);
assert.equal(typeof packageJson.scripts.dist, "string");
assert.equal(packageJson.build.portable.artifactName, "MiniMax H3 Studio.exe");

for (const name of ["MiniMax-H3-图生视频.json", "MiniMax-H3-参考生视频.json", "MiniMax-H3-文生视频.json"]) {
  const graph = JSON.parse(fs.readFileSync(path.join(workflowDir, name), "utf8"));
  const nodes = Object.values(graph);
  assert.ok(nodes.some((node) => node.class_type === "SaveVideo"), `${name}: missing SaveVideo`);
  assert.ok(nodes.some((node) => ["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"].includes(node.class_type)), `${name}: missing H3 node`);
}

const assetA = { assetId: "asset-a", type: "image", filePath: "A.png" };
const assetB = { assetId: "asset-b", type: "image", filePath: "B.png" };
const assetC = { assetId: "asset-c", type: "image", filePath: "C.png" };
const reordered = parseReferencePrompt({ parts: [
  { type: "mention", assetId: assetA.assetId, label: "图1" },
  { type: "text", text: " 和 " },
  { type: "mention", assetId: assetB.assetId, label: "图2" },
] }, [assetB, assetA]);
assert.deepEqual(reordered.references.map((item) => [item.assetId, item.modelToken]), [[assetA.assetId, "<Picture 2>"], [assetB.assetId, "<Picture 1>"]]);
assert.equal(reordered.cleanedPrompt, "<Picture 2> 和 <Picture 1>");
assert.equal(reordered.workflowInputs.videos, undefined);
assert.equal(reordered.workflowInputs.audios, undefined);
assert.deepEqual(reordered.workflowInputs.images.map((item) => item.assetId), [assetB.assetId, assetA.assetId]);

const deleted = parseReferencePrompt({ parts: [
  { type: "mention", assetId: assetA.assetId, label: "图1" },
  { type: "text", text: " 保持主体 " },
] }, [assetB]);
assert.equal(deleted.invalidMentions.length, 1);
assert.equal(deleted.references.length, 0);
assert.match(promptPartsToText(deleted.parts, [assetB]), /图1/);

const typedMention = parseReferencePrompt({ parts: [{ type: "text", text: "@图1 作为背景" }] }, [assetC]);
assert.equal(typedMention.parts[0].type, "mention");
assert.equal(typedMention.parts[0].assetId, assetC.assetId);
assert.equal(typedMention.cleanedPrompt, "<Picture 1> 作为背景");

const unsupported = parseReferencePrompt({ parts: [] }, [{ assetId: "asset-video", type: "video", filePath: "clip.mp4" }]);
assert.deepEqual(unsupported.unsupportedAssets, [{ assetId: "asset-video", type: "video" }]);
assert.equal(unsupported.workflowInputs.images.length, 0);

console.log("smoke checks passed");
