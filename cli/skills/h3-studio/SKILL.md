---
name: h3-studio
description: 调用本机 MiniMax H3 Studio 生成视频和语音，增强图片或视频，补帧、分割抠图、理解图片，以及查询和管理 H3 任务。适用于用户要求用 H3 执行媒体处理或对接其本机 API。
---

使用已安装的 `h3` CLI；若不在 PATH，查找 `%LOCALAPPDATA%/H3CLI/h3.cmd`。H3 桌面程序必须正在运行，模型在本机执行。

首次连接执行 `h3 auth login --app-root "H3安装目录/App"`。此操作验证本机连接，不需要云端账号；不要要求用户提供或展示 `user/studio-api.json` 中的 token。每次调用 CLI 会重新读取当前端口和凭据。

先运行 `h3 doctor` 和 `h3 capabilities` 检查引擎、模型和可用功能。未安装的模型不应报告可用。详细参数和例子见 [接口用法](references/api.md)。

任务通过 `h3 task KIND --input @输入.json --wait` 提交；视频通过 `h3 generate --input @视频.json --wait`。文件采用 UTF-8，媒体使用本机绝对路径。stdout 是 JSON，退出码非零代表失败或等待超时。输出以返回的实际路径为准。

工具任务可使用 `--request-key` 防止重复提交同一请求。等待超时或连接中断时，先用 `h3 jobs list/get/wait` 查证，不要直接重复生成。`h3 jobs cancel ID` 只取消指定任务，不中断无关桌面任务。

删除、清空、恢复等操作通过 `h3 action` 的 `--confirm` 明确确认范围；只在用户授权的范围内调用。接口仅限本机，不将描述文件或 token 上传到外部服务。
