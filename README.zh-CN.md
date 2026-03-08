# Codian

[English README](README.md)

![GitHub stars](https://img.shields.io/github/stars/liuhao8105/codian?style=social)
![GitHub release](https://img.shields.io/github/v/release/liuhao8105/codian)
![License](https://img.shields.io/github/license/liuhao8105/codian)

![Preview](Preview.png)

`Codian` 是一个 Obsidian 插件，用来在你的仓库里直接使用 `Codex`。

它的核心思路很简单：
- 你的 Obsidian 仓库就是 Codex 的工作目录
- 你可以直接在笔记环境里聊天、改写、看图、读写文件、执行多步任务
- 保留了类似 `claudian` 的使用体验，但底层已经改成 `Codex`

## 项目来源

本项目基于开源项目 [`YishenTu/claudian`](https://github.com/YishenTu/claudian) 修改而来，
目标是把原先以 `Claude / Claudian` 为核心的插件体验，迁移为面向 `Codex / Codian`
的可用版本。

上游项目采用 MIT 许可证，本仓库保留了原始许可证声明。

## 当前状态

- 插件名称、界面和主要用户文案已经切换为 `Codian / Codex`
- 主聊天链路已经切换为 `Codex App Server`
- 支持真实流式输出
- 支持行内编辑
- 支持图片识别
- 支持读取当前笔记与笔记中的嵌入图片
- 支持重启 Obsidian 后恢复历史对话

## 主要功能

- **聊天协作**：在 Obsidian 里直接使用 Codex 读、写、改文件
- **上下文感知**：自动带上当前笔记、编辑器选区、`@文件`、外部目录等上下文
- **图片理解**：支持拖拽图片、粘贴图片，以及识别笔记中的 `![[图片]]`
- **行内编辑**：选中文本后直接改写、补写、润色
- **命令与技能**：支持 `/命令`、技能、子代理、MCP 扩展
- **历史恢复**：支持会话切换、重启后继续查看和追问历史内容

## 运行要求

- 已安装 `Codex CLI`
- Obsidian `v1.8.9+`
- 可用的 Codex 运行环境
- 仅支持桌面端：macOS / Linux / Windows

## 安装方式

### 方式一：从 GitHub Release 安装

1. 下载或自行构建这 3 个文件：
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. 在你的 Obsidian 仓库下创建目录：

   ```text
   /path/to/vault/.obsidian/plugins/codian/
   ```

3. 把上面 3 个文件放进去
4. 打开 Obsidian：
   - 设置
   - 社区插件
   - 启用 `Codian`

### 方式二：使用 BRAT 安装

[BRAT](https://github.com/TfTHacker/obsidian42-brat) 可以直接从 GitHub 安装测试版插件。

1. 在 Obsidian 里安装 BRAT
2. 打开 BRAT 设置
3. 点击 `Add Beta plugin`
4. 输入仓库地址：

   ```text
   https://github.com/liuhao8105/codian
   ```

5. 添加后启用 `Codian`

### 方式三：从源码安装

```bash
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/liuhao8105/codian.git
cd codian
npm install
npm run build
```

然后在 Obsidian 的社区插件中启用 `Codian`。

## 基本使用

### 1. 打开聊天

- 点击左侧按钮
- 或用命令面板打开 `Codian`

### 2. 直接对话

你可以像在 Codex 里一样直接提需求，例如：

- 解释当前笔记内容
- 帮我整理这篇笔记
- 修改这段文本
- 看这张图里是什么

### 3. 使用上下文

- **当前笔记**：会自动附带
- **`@文件`**：输入 `@` 选择仓库里的其他文件
- **选中文本**：聊天时会自动带上
- **图片**：支持拖拽、粘贴、笔记嵌入图
- **外部目录**：可通过工具栏手动加入

### 4. 行内编辑

1. 在笔记里选中文本
2. 触发 `Codian: Inline edit`
3. 输入你的修改要求
4. 查看结果并应用

## 设置说明

你日常最常用的是这几类设置：

- **Codex CLI 路径**
  - 找不到 Codex 时，在这里手动填写
- **自定义变量**
  - 配置运行时环境变量
- **媒体目录**
  - 告诉插件笔记中的嵌入图片通常放在哪
- **自动滚动**
  - 控制流式回答时是否自动滚到底部
- **标题生成**
  - 是否自动给会话生成标题

已经做过一轮设置页收口：
- 子代理、MCP 服务器、兼容迁移项已被折叠
- 常用设置更容易找到

## 常见问题

### 1. 找不到 Codex CLI

先在终端执行：

```bash
which codex
```

如果能看到路径，就把它填进：

- `设置 -> Codex CLI 路径`

常见路径示例：

- macOS / Linux：

  ```text
  /Applications/Codex.app/Contents/Resources/codex
  ```

- Windows：

  ```text
  C:\Path\To\codex.exe
  ```

### 2. 重启后历史对话不见了

当前仓库版本已经补过这类恢复逻辑。

如果你仍遇到问题，请优先检查：
- 是否真的启用了 `Codian`
- 是否打开的是同一个 Obsidian 仓库
- `Codex CLI` 是否仍可运行

如仍有问题，请到仓库提 issue：

- [https://github.com/liuhao8105/codian/issues](https://github.com/liuhao8105/codian/issues)

## 隐私与数据

- 发送到模型侧的数据：
  - 你的输入
  - 你附带的文件上下文
  - 图片
  - 工具调用结果
- 本地保存的数据：
  - 插件设置
  - 会话元数据
  - 会话历史与兼容文件
- 本项目默认不额外做遥测上报

## 版本说明

首个公开版本说明见：

- [CHANGELOG.md](CHANGELOG.md)

## 致谢

- [Obsidian](https://obsidian.md)
- [OpenAI Codex](https://openai.com)
- 上游开源项目 [`YishenTu/claudian`](https://github.com/YishenTu/claudian)
