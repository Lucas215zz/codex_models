# Codex 模型迁移包 — Windows / macOS 双平台部署说明

把这台电脑的 Codex 模型体系（本地路由器 + wbm/wb2 等全部模型）搬到新电脑。
**Windows 电脑和 Mac 电脑用的是同一个包**，脚本会自动识别系统。

## 🔑 关于密钥（重要）

**本仓库不包含任何真实 API Key**（安全起见不上传）。
所有密钥位置都被替换成了 `PASTE_YOUR_KEY_HERE` 占位符，部署时需要自己填回：

| 位置 | 要填的 key |
|---|---|
| `codex-model-router\keys\wbm.txt` | WBm 中转 (www.agentaipilot.com) 的 key |
| `codex-model-router\keys\wb2.txt` | WB2 中转 (wbsub2.lusixian.com) 的 key |
| `codex-model-router\keys\4z.txt` | 4Z API 的 key |
| `codex-model-router\keys\kimi.txt` | Moonshot Kimi 的 key |
| `codex-config\config.toml` | 8 处 `experimental_bearer_token`（各官方渠道 token） |
| `codex-model-router\router-config.json` | 6 处 `"key": "PASTE_YOUR_KEY_HERE"` |

密钥改 `keys\*.txt` 即时生效，不用重启路由器；改 config.toml / router-config.json 需重启路由器。

## 🔄 更新流程（本仓库的用法）

模型列表 / 渠道配置有变动时：
1. 在任意一台已部署的电脑上修改 `model-catalog.json` 或 `router-config.json`
2. 把**脱敏后**的文件提交推送到本仓库
3. 其他电脑 `git pull` 后重启路由器 + Codex 即可同步
⚠️ 提交前确认没把真实 key 写进去（提交真 key 到 GitHub 后即使删除也可能被缓存，只能作废重签）


## 前提（新电脑只需要两样）

1. ✅ 已安装 **Codex 桌面版**
2. ✅ 已安装 **Node.js** ≥ 18
   - Windows：https://nodejs.org 下载 LTS 一路下一步
   - Mac：终端执行 `brew install node`，或官网下 pkg

## Windows 电脑

1. 把整个 `codex-models-migration` 文件夹拷过去（任意位置）
2. 双击 **`setup.cmd`**，等它显示 `DONE`
3. （可选，建议）双击 `codex-model-router\install-autostart.cmd` 装开机自启
4. 重启 Codex 桌面版 → 模型列表出现全部 wbm-/wb2- 模型

## Mac 电脑

1. 把整个 `codex-models-migration` 文件夹拷过去（任意位置）
2. 打开「终端」，把文件夹拖进终端窗口，然后执行：
   ```bash
   cd 拖进来的文件夹路径
   node setup.mjs
   ```
   （或双击 `setup-mac.command`；若提示无权限，先执行 `chmod +x setup-mac.command`）
3. 脚本会自动：装路由器到 `~/codex-model-router`、写好 `~/.codex/` 配置、
   **删掉 Windows 的 Clash 代理设置（Mac 直连）**、注册 launchd 开机自启、发测试消息验证
4. 重启 Codex 桌面版 → 模型列表出现全部 wbm-/wb2- 模型

## Mac 特别注意

- 脚本已自动删除配置里的 `proxy: 127.0.0.1:7897`（那是 Windows 电脑的 Clash 端口）。
  如果 Mac 上外网请求不通（表现为所有模型超时），说明你的网络需要代理才能访问中转站，
  把 `~/codex-model-router/router-config.json` 里的 `"proxy"` 字段改回 Mac 实际代理端口再重启路由器。
- 路由器日志：`/tmp/codex-model-router.log` 和 `/tmp/codex-model-router.err.log`
- 自启管理：`launchctl unload ~/Library/LaunchAgents/com.codex.model-router.plist` 可停用

## 包内文件说明

| 文件/文件夹 | 作用 |
|---|---|
| `setup.cmd` / `setup.mjs` / `setup-mac.command` | 一键部署脚本（Win / 双平台核心 / Mac 双击入口） |
| `codex-model-router\` | 本地模型路由器（server.mjs、分流配置、各渠道密钥 keys\） |
| `codex-config\` | Codex 主配置 + 全部模型清单 |
| `mac\com.codex.model-router.plist` | Mac 开机自启配置 |

## 常见问题（两平台通用）

- **模型列表是空的 / 连不上**：浏览器打开 http://127.0.0.1:8788/__routes 能看到渠道表即路由器正常
- **某个渠道报 401**：对应 key 在 `codex-model-router\keys\` 里，换成新 key 即可（改完即时生效，不用重启）
- **想换默认模型**：改 `~\.codex\config.toml` 第 2 行 `model = "..."`

⚠️ 密钥都在包里（keys\ 目录和 config.toml），**不要把这个包发给别人**。
