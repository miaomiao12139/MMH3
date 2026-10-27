# H3 CLI / HTTP

所有 CLI 命令均可 `--help`。输入对象用 `--input @绝对路径.json`，避免 shell 引号差异。

| 功能 | 命令 | input 字段 |
| --- | --- | --- |
| 图片增强 | `h3 task image-enhance` | `file` |
| 视频增强 | `h3 task enhance` | `file` |
| 视频补帧 | `h3 task interpolate` | `file`, `multiplier` (2/3/4) |
| 图像理解 | `h3 task understand` | `file`, `prompt` |
| 自动抠图 | `h3 task segment` | `file`, `segmentMode: "automatic"` |
| 精确分割 | `h3 task segment` | `file`, `segmentMode: "interactive"`, `segmentPrompts` |
| 语音合成 | `h3 task voice` | `text`, `engine: "kokoro"/"melo"`, `voice`, `speed` |
| 批量抠图 | `h3 task cutout-batch` | `media: [绝对路径]` |
| 视频生成 | `h3 generate` | `workflow`, `prompt`, `media`, `settings` |

每条提交命令必须附 `--input`；附 `--wait --timeout 3600` 等待结果。Kokoro 默认音色 zf_001；Melo 使用 ZH。音色列表查 capabilities.voice。视频 workflow：t2v、i2v、r2v、continuation、multiframe、control。实际工作流参数先查 `h3 action workflow.get --args '["t2v"]'` 及 `h3 openapi`。

精确分割示例：`segmentPrompts: {"points":[{"x":0.5,"y":0.5,"label":1}],"box":null,"strokes":[]}`。坐标归一化到0–1；label 1保留、0排除。box 为 `{x,y,width,height}`；strokes 为 `[{label:1,radius:0.02,points:[{x:0.5,y:0.5}]}]`。至少有一个保留点、保留笔画或框。

`h3 jobs list` 同时列出视频队列与工具任务；`h3 jobs get ID`、`h3 jobs wait ID`、`h3 jobs cancel ID` 自动选择对应接口。工具任务状态：queued/running/completed/failed/cancelled/interrupted。返回 result 包含路径或理解文本；失败可能保留部分批量结果。

`h3 action NAME --args @参数数组.json [--confirm]` 开放队列、工作流、偏好、历史管理。查询 capabilities.actions 获取精确名称；args 是与桌面对应的有序参数数组。删除、清空、移除、重置和恢复必须 confirm。可先 `h3 action preferences.get`、`h3 action storage.usage`。

HTTP 只监听 127.0.0.1，Bearer token 每次启动变化，描述文件为 App/user/studio-api.json。`h3 api GET /api/v1/openapi.json` 可取接口说明。`POST /api/v1/tasks` 请求是 `{ "kind": "voice", "input": {"text":"你好"} }`，返回 202 与 job.id；可附 Idempotency-Key（最多128字符，同键不同输入拒绝）。POST /api/v1/generate 使用视频参数对象。POST /api/v1/actions 为 `{ "action": "preferences.get", "args": [] }`。

CLI 不启动远程服务、不下载模型；调用需要已安装 H3 1.1.16+。Linux/macOS 没有本地 H3 引擎，不应宣称可以直接运行模型。

## 管理参数数组

| action | args |
| --- | --- |
| queue.pause / queue.resume | [] |
| queue.retry / queue.remove | [任务ID] |
| queue.reorder | [任务ID, 排队位置从0计] |
| queue.clear | ["finished"] 仅完成，或 ["all"] 所有终态；不删除正在运行的任务 |
| queue.retention.get / queue.retention.set | [] / [天数] |
| workflow.get / workflow.reset / workflow.backups | [workflowID] |
| workflow.save | [workflowID, 工作流JSON对象或字符串] |
| workflow.restore | [workflowID, backupID] |
| workflow.preflight | [{workflow,media,referenceAssets,settings}] |
| preferences.get / preferences.set | [] / [键,值] |
| asset.stage / asset.prune | [媒体绝对路径] / [[待清理路径]] |
| reference.capabilities | [] |
| engine.health / storage.usage | [] |
| voice.delete / voice.clear | [WAV绝对路径] / [] |
| cutout.delete / cutout.clear | [记录ID] / [] |
| video.favorite | [视频绝对路径,布尔值] |
| video.rename | [视频绝对路径,新文件名] |
| video.delete | [视频绝对路径] |
| video.clear | [workflowID或空字符串, "records"仅清记录或"delete"删除文件] |

配置导入/导出可由调用者读写 workflow.get/save 与 preferences.get/set 的 JSON；结果导出由调用者复制返回的 resultPath、outputPaths 或音频 path，无需桌面文件选择框。
