# hoswing-mcp

本地 MCP 适配器，把 **Hoswing ID-Master** 的画布能力接给 AI 客户端：
读模型目录、按分镜批量建任务、拿报价、串行生成、断点恢复、下载成品。

> 非官方。根据网站公开前端请求实现，网站改版后可能需要维护。
> 输出逐镜素材与清单，不自动剪辑、配音或拼接成整条影片。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 模型目录 | 读项目里当前可用的模型、操作类型、参数范围和计费方式 |
| 分镜导入 | CSV / XLSX / JSON 或直接传 `shots` 数组，一次 1–200 镜 |
| 报价 | 提交前逐镜要报价，不生成、不上传素材 |
| 生成 | 串行提交，同一任务幂等恢复，网络中断不会重复扣费 |
| 下载 | 结果落到 `data/outputs/<jobId>/`，带 manifest |
| 诊断 | 截图当前网站标签页 |

支持图片（`image.generate` / `image.edit`）和视频（`video.generate`）。

---

## 环境要求

- **Node.js 22+**
- **Microsoft Edge**（或其他 Chromium），需要以调试端口启动
- 一个 Hoswing 账号

---

## 安装

```bash
git clone <这个仓库>
cd hoswing-mcp
npm install
```

---

## 配置

全部通过环境变量，**不要把个人信息写进代码**：

| 变量 | 必填 | 说明 |
|---|---|---|
| `HOSWING_PROJECT_ID` | 是 | Hoswing 里目标项目的 ID（网址 `?projectId=` 后面那串） |
| `HOSWING_CDP_URL` | 否 | 浏览器调试地址，默认 `http://127.0.0.1:9333` |
| `HOSWING_DATA_DIR` | 否 | 任务/成品目录，默认项目内 `data/` |

### 启动浏览器

浏览器必须带调试端口，并且**登录后不要关那个标签页**（令牌存在 sessionStorage）：

```bash
node scripts/open-browser.mjs
```

或者自己起一个：

```bash
msedge.exe --remote-debugging-port=9333 --user-data-dir=<一个专用目录> https://www.hoswing.cn/idmaster
```

### 登录

密码可选地加密保存在本地（Windows DPAPI，绑定当前系统用户）：

```bash
node scripts/save-login.mjs <账号>
# 提示输入密码，不进命令行历史
```

之后自动登录：

```bash
node scripts/login.mjs
```

`.secrets/` 已被 `.gitignore` 排除，**不会进仓库**。
不想存密码就手动在浏览器里登录，脚本会检测到已登录并直接复用。

### 注册到 AI 客户端

Claude Code 用户级配置（`~/.claude.json`）：

```json
{
  "mcpServers": {
    "hoswing": {
      "command": "node",
      "args": ["<绝对路径>/hoswing-mcp/src/server.mjs"],
      "env": {
        "HOSWING_PROJECT_ID": "<你的项目ID>",
        "HOSWING_CDP_URL": "http://127.0.0.1:9333"
      }
    }
  }
}
```

Windows 上 `command` 要写 `node.exe` 的绝对路径。改完**重启客户端**。

---

## 工具

| 工具 | 用途 |
|---|---|
| `hoswing_status` | 检查浏览器连接与登录，不返回令牌 |
| `hoswing_open_login` | 复用/打开 Hoswing 标签页供登录 |
| `hoswing_models` | 读项目当前模型目录 |
| `hoswing_project` | 只读项目与画布摘要 |
| `hoswing_create_job` | 导入分镜，建立**本地**任务（不上传、不生成） |
| `hoswing_quote_job` | 拿逐镜报价 |
| `hoswing_start_job` | 启动或恢复任务（需明确授权上传与积分上限） |
| `hoswing_get_job` | 查进度、错误、下载路径 |
| `hoswing_stop_job` | 停止后续镜头并请求取消当前生成 |
| `hoswing_download_completed` | 补下载已成功的结果，不重新生成 |
| `hoswing_screenshot` | 保存当前网站截图 |

命令行调用：

```bash
node scripts/call.mjs hoswing_status
node scripts/call.mjs hoswing_models
node scripts/call.mjs hoswing_create_job @shots.json
node scripts/call.mjs hoswing_quote_job '{"jobId":"job-xxx"}'
```

`shots.json` 形如：

```json
{
  "mode": "image",
  "provider": "<从 hoswing_models 取>",
  "modelId": "<从 hoswing_models 取>",
  "operation": "image.generate",
  "shots": [
    { "id": "s1", "title": "镜头1", "prompt": "画面描述", "aspectRatio": "16:9" }
  ]
}
```

---

## 分镜字段

| 字段 | 说明 |
|---|---|
| `id` | 唯一编号 |
| `title` | 镜头标题，用于下载命名 |
| `prompt` | 必填提示词 |
| `imagePrompt` | 图片模式优先使用 |
| `durationSeconds` | 视频时长，默认 5 秒，范围以模型为准 |
| `aspectRatio` | 默认 16:9 |
| `references` | 本地素材路径数组 |
| `firstFrame` / `lastFrame` | 本地图片，仅视频模式 |
| `referenceAssetVersionIds` | 网站上已有的固定资产版本 ID |

表格里的相对素材路径以表格目录解析；直接传 `shots` 时设置 `assetDir`。
模板见 `examples/分镜表.csv`。

---

## 安全与费用

- **积分上限**：`hoswing_start_job` 必须传 `maxCredits`，超出就中止，不会无限花
- **不自动重试**：提交结果不确定时只按原幂等键找回同一任务，**绝不重新提交**
- **令牌**：存在标签页 sessionStorage，不写日志、不写文件
- **凭据**：密码用 DPAPI 加密，只有当前 Windows 用户能解

---

## 开发

```bash
npm test     # 本地流程与故障恢复测试
npm run smoke # MCP 握手 + 浏览器状态
```

| 文件 | 负责 |
|---|---|
| `src/core.mjs` | 解析、任务持久化、锁、节点与报价结构 |
| `src/browser.mjs` | CDP 连接、会话、网站请求、上传下载 |
| `src/pipeline.mjs` | 报价、保存画布、提交恢复、查询、执行 |
| `src/server.mjs` | MCP 工具声明与工作进程启动 |
| `src/worker.mjs` | 后台任务入口 |

---

## 已知限制

- 非官方适配器，网站前端一改就可能失效
- 画布是共享的：多个任务同时跑时靠读回校验和重试兜底，极端情况下仍可能冲突
- 只下载素材，不做剪辑、配音、拼接
