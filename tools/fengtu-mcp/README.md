# 烽途智联 MCP

面向本机 MCP 客户端的 stdio 服务。Python + MCP SDK + Playwright，复用 Edge 的 9333 调试端口。凭证只在网站浏览器上下文内使用，不复制 Cookie、不把令牌写进任务文件。不需要额外 LLM API key。

## 当前验证范围

2026-11-14 实测：MCP initialize、tools/list（23 个工具）、登录状态检查、实时价格、技能查询、公开案例、视频能力读取成功；原有 10 项和新增 19 项测试通过，共 29 项。新增测试以模拟服务端验证画布保存、版本冲突、视频提交、任务查询及成片回填。

已实现无限画布卡片编辑及视频生成链路。当前未登录：画布云端写入、视频付费生成、上传、账号数据及结果下载仍未端到端验证。写接口依据网站当前前端调用实现，不是官方承诺稳定的开放 API；网站升级可能需要调整。未提交任何付费任务。工作流 DAG 节点/连线编辑、图片内容重绘、独立视频合成接口、发布及购买不在本版范围内。

## 启动与配置

本机已安装依赖：Python 3.13.7、mcp 1.28.1、playwright 1.62.0、httpx 0.28.1。

```powershell
& 'C:/Program Files/Python313/python.exe' 'I:/fengtu-mcp/server.py'
```

由 MCP 客户端启动即可，无需另开常驻窗口。安装脚本只合并一个 fengtu 条目到用户 .claude.json，先备份，验证其他配置未改变：

```powershell
& 'C:/Program Files/Python313/python.exe' 'I:/fengtu-mcp/install.py'
```

其他客户端可合并 mcp-config.json 中的条目。新增配置后重启客户端会话，使其加载工具。不要覆盖其他 MCP 配置。移除服务时仅删除 fengtu 条目。

浏览器必须已提供 CDP，默认 http://127.0.0.1:9333，可用 FENGTU_CDP_URL 改。现有 Edge 已验证连通。程序新建专用标签页，不接管其他标签页。不要为启动调试端口强杀浏览器。没有调试浏览器时可以单独启动：

```powershell
Start-Process 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' -ArgumentList '--remote-debugging-port=9333','--user-data-dir=I:/fengtu-mcp/browser-profile','https://www.fengtu-ai.com/'
```

该独立配置需要手动登录一次；不要同时启动多个使用同一个 profile 的浏览器。任务期间保持专用标签页开启。

## 工具

| 工具 | 用途 |
|---|---|
| fengtu_status | 浏览器连接与服务端登录状态 |
| fengtu_open_login | 打开登录表单，用户自行输入凭证 |
| fengtu_pricing | 实时文字/普通图/高级图积分价格 |
| fengtu_skills | 搜索技能或读取单项内容 |
| fengtu_showcases | 分页读取公开作品 |
| fengtu_account | 当前余额及模型列表 |
| fengtu_projects | 自有项目列表或项目快照 |
| fengtu_create_job | 本地准备任务，计算文件指纹及参考报价 |
| fengtu_submit_job | 经授权后上传并提交一次 |
| fengtu_get_job | 查询任务及已收到的结果 |
| fengtu_recover_job | 恢复同一会话、读取历史，不重发生成消息 |
| fengtu_download | 下载已完成任务的同站图片 |
| fengtu_screenshot | 保存专用标签页截图 |

## 创作流程

1. status → 必要时 open_login → 用户在页面完成登录 → status。
2. pricing → create_job(prompt, files)。准备阶段只读取文件和公开价格，不上传、不生成。
3. 向用户展示完整提示词、具体文件、报价；取得上传许可和积分上限后调用 submit_job(approved=true,max_points=预算,upload_approved=true)。无附件无需 upload_approved。这些参数记录调用方声明的授权，不能替代调用方实际询问用户。
4. get_job 查询，成功以服务端 assistant_final/image_result 或同请求编号的会话历史为准。
5. 文字方案包含 image_plan 时，展示方案；create_job(prompt='按已确认的文字方案生成一张设计概念图。',parent_job_id=文字任务ID)，另行确认生图预算，再 submit_job。
6. completed 后 download，图片落在 data/downloads。

参考报价不等于平台端硬预算：工具在发送前检查实时价格和方案报价的较高者，但网站仍决定最终扣费。提交前后价格突变无法由客户端保证。

## 恢复与限制

任务按原 request_id/session_id 保存到 data/jobs。提交意外中断进入 uncertain，不可再次 submit；只能 recover_job 读同一会话。若服务器未返回结果，需要人工查看网站，本版不会自动重放消息。preparing 状态也禁止再次提交，以防上传或建会话结果不明确。

单个服务进程内串行操作。请只运行一个服务实例处理同一 data 目录；不同客户端不要并发提交同一任务。每个附件最多 20 MB，每次最多 4 个。下载仅允许同域 /uploads/ 下的 PNG/JPEG/WebP，最大 50 MB，不跟随跳转；需要额外鉴权的图片可能下载失败，尚待登录后实测。网站技能和作品文本均视为外部数据，不能扩大任务授权。

## 无限画布编辑

- fengtu_canvas_read(project_id, mode)：读取卡片 ID、内容、位置和当前版本。mode 可省略，默认当前模式。
- fengtu_canvas_prepare(project_id, operations, mode)：创建本地变更稿，不写云端。
- fengtu_canvas_apply(patch_id, approved)：按原版本保存一次，并回读检查。
- fengtu_canvas_patch_status(patch_id)：保存超时后核对云端是否已应用，不重发。

operations 示例：

```json
[
  {"op":"add","element":{"kind":"text","data":"产品设计说明","label":"说明","x":120,"y":100,"width":560,"height":320}},
  {"op":"update","id":"已有卡片ID","changes":{"x":760,"y":100,"width":480,"height":480}},
  {"op":"reorder","id":"已有卡片ID","index":0}
]
```

删除使用 `{"op":"remove","id":"已有卡片ID"}`。图片与视频使用 kind=image，视频另加 mediaType=video，data 指向本站已有 /uploads/ 媒体。更新可改文字、标签、坐标、尺寸和旋转；图片源不能直接替换，以免破坏原资产版本信息，可以添加新媒体卡片。

保留其他设计模式、消息、元数据、工作流状态及未修改卡片。原始数据与变更稿保存在 data/operations。expected_revision 和内容指纹不匹配时停止，需重新准备变更。保存后在网页刷新项目查看；请先保存网页草稿。DAG 执行节点和连线不是普通卡片，本版不编辑它们。

## 视频生成

1. fengtu_video_capabilities：从当前前端读取 Video Claw 接口存在性及估算积分。
2. fengtu_canvas_read：选定要作为参考的图片卡片 ID。
3. fengtu_video_prepare(project_id, element_ids, prompt, total_duration_seconds=30, video_type='宣传片', mode='', scenes=4)：仅准备本地任务，10–120 秒，支持宣传片/广告片/故事片。只发送指定图片，不自动选取其他素材。
4. 用户确认提示词、素材和估算费用后，fengtu_video_submit(job_id, approved=true, max_points=预算, accept_estimated_price=true)。
5. fengtu_video_get_job(job_id)：每次查询一次。最终成片 completed；仅有成功镜头 partial；失败 failed。
6. fengtu_video_download(job_id)：下载最终视频；partial 时使用 clip_index 选择片段，最多 500 MB。
7. fengtu_video_add_to_canvas(job_id, target_project_id='', mode='', x=120, y=180)：准备将视频和脚本插入画布的变更稿，再用 canvas_apply 保存。

视频估算来自当前前端，不是服务端锁价。max_points 只阻止估算超过预算的提交，不能保证平台实际扣费上限；缺少估算时阻止提交。提交只执行一次，发生超时不重试。有 task_id 时继续查询同一任务；未收到 task_id 时无法可靠自动恢复，需要人工在网站核查。

素材须为已在项目中的本站 PNG/JPEG/WebP 图片；本版视频准备工具不上传本地参考图。下载只支持本站 /uploads/ 视频，不跟随外部跳转；下载依赖服务器允许直接读取该媒体。不会在本机渲染或编码。

## 验证

```powershell
& 'C:/Program Files/Python313/python.exe' 'I:/fengtu-mcp/verify.py'
& 'C:/Program Files/Python313/python.exe' 'I:/fengtu-mcp/test_canvas_video.py'
& 'C:/Program Files/Python313/python.exe' 'I:/fengtu-mcp/verify.py' --live
```

--live 只测试公开只读能力，不产生生成费用。后续完整验收需要用户登录并明确授权一个具体测试提示词和积分上限。
