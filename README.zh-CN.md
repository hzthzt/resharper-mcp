# ReSharper MCP Server

[English](README.md) | **简体中文**

这是一个运行在 ReSharper/Rider 后端进程中的 MCP（Model Context Protocol，模型上下文协议）服务器，通过 HTTP 向 AI 助手提供代码智能功能。

支持 C#、F#、VB，以及任何具有 ReSharper PSI 实现的语言。

## 工具

服务器提供 23 个工具：17 个只读工具和 6 个源码修改工具。

### 只读工具

| 工具 | 说明 |
|------|------|
| `find_usages` | 查找符号的所有引用 |
| `get_symbol_info` | 获取符号的详细信息：种类、类型、参数、文档、基类型和成员 |
| `find_implementations` | 查找接口、抽象类的实现及重写 |
| `get_file_errors` | 获取编译错误和无法解析的引用 |
| `search_symbol` | 在整个解决方案中按名称搜索符号（支持子字符串匹配） |
| `go_to_definition` | 跳转到符号声明并返回源代码文本 |
| `get_solution_structure` | 列出项目、目标框架和项目引用 |
| `browse_namespace` | 浏览命名空间层级：子命名空间和类型 |
| `list_symbols_in_file` | 列出文件中的所有声明 |
| `list_solutions` | 列出所有 Rider 实例中打开的解决方案 |
| `flow` | 描述方法或类型的控制流：执行步骤、分支、循环、错误路径和内联调用目标 |
| `get_symbol_source` | 获取符号的完整声明源码，而不只是片段 |
| `get_call_hierarchy` | 为方法构建传入（调用方）或传出（被调用方）调用层级树 |
| `get_type_hierarchy` | 获取类型的继承层级：父类型（基类/接口）或子类型 |
| `get_diagnostics` | 对文件运行后台代码检查，报告严重级别、检查 ID、消息、位置及快速修复可用性 |
| `list_quick_fixes` | 列出指定位置可用的 ReSharper 快速修复（灯泡操作） |
| `complete_at` | 获取指定光标位置的代码补全建议 |

### 源码修改工具

以下工具会修改源文件，并在 ReSharper 的写锁下运行：

| 工具 | 说明 |
|------|------|
| `fix_usings` | 修复 C# 文件中缺失的 using 指令 |
| `format_file` | 格式化、清理文件或应用代码样式 |
| `rename_symbol` | 对符号及其所有引用执行解决方案范围的语义重命名（支持 `dryRun`） |
| `generate_members` | 为类型生成成员（构造函数、重写、相等性成员等） |
| `apply_quick_fix` | 在指定位置应用 ReSharper 快速修复（灯泡操作） |
| `apply_suggestions` | 按检查 ID 在整个文件中应用检查快速修复（例如将显式构造函数转换为主构造函数）；无需指定位置，支持 `dryRun`/`all` |

### 符号解析

操作符号的工具支持两种定位方式：

- **按位置**：`filePath` + `line` + `column`（从 1 开始）
- **按名称**：`symbolName`（例如 `"MyClass"`、`"Namespace.MyClass"`、`"MyClass.MyMethod"`）

可选的 `kind` 筛选器（`"type"`、`"method"`、`"property"`、`"field"`、`"event"`）可帮助消除歧义。当多个符号匹配时，工具会返回歧义错误，并列出所有候选项的限定名称、种类和位置。

### 多解决方案定位

多个 Rider 实例可以共享同一个 MCP 端点。调用 `list_solutions` 发现已打开的解决方案；打开多个解决方案时，再向其他工具传入 `solutionName`。如果多个解决方案同名，也可以使用唯一的路径片段进行定位。

### 批处理模式

大多数工具支持批处理模式，即在一次调用中处理多个输入。查询多个符号或文件时，这可以减少往返次数：

- **基于符号的工具**（`find_usages`、`get_symbol_info`、`find_implementations`、`go_to_definition`）接受由 `{symbolName, kind, filePath, line, column}` 对象组成的 `symbols` 数组。
- **基于文件的工具**（`get_file_errors`、`list_symbols_in_file`、`fix_usings`、`format_file`）接受由字符串组成的 `filePaths` 数组。
- **`search_symbol`** 接受字符串数组 `queries`。
- **`browse_namespace`** 接受字符串数组 `namespaceNames`。

结果使用 `=== [N/total] label ===` 分隔符拼接。共享选项（例如 `maxResults`、`kinds`、`mode`）会应用于所有输入。为保持向后兼容，原有的单输入参数仍然可用。

## 安装

### 从 JetBrains Marketplace 安装

在 Rider 中打开 **Settings → Plugins → Marketplace**，搜索“MCP Server for Code Intelligence”并安装。

### 从源码安装

```bash
./install-rider.sh
# 重启 Rider
```

该脚本会构建插件，并将其复制到本地 Rider 插件目录。

## MCP 客户端配置

将以下内容添加到 MCP 客户端配置中（例如 Claude Code 的 `settings.json`）：

```json
{
  "mcpServers": {
    "resharper": {
      "type": "http",
      "url": "http://127.0.0.1:23741/"
    }
  }
}
```

在 Rider 中打开解决方案后，服务器会自动启动。

设置 `RESHARPER_MCP_PORT` 环境变量可覆盖默认端口。

## Codex Skill（渐进披露）

本仓库还提供 `resharper-code-intelligence` Codex Skill。它通过随附的 Node.js 客户端调用同一个本地 Rider 端点，但只会在 Skill 选定某个工具后公开该工具的 schema。Codex 无需在会话启动时注册全部 23 个 ReSharper 工具。

### 安装

前置条件：

- 安装此 Rider 插件并打开一个解决方案。
- 安装 Node.js 18 或更高版本。
- 保持端点为 `http://127.0.0.1:23741/`，或设置 `RESHARPER_MCP_URL`。

让 Codex 从 GitHub 安装 Skill：

```text
使用 $skill-installer 从 https://github.com/hzthzt/resharper-mcp/tree/main/skills/resharper-code-intelligence 安装该 skill。
```

安装完成后，该 Skill 会在 Codex 的下一轮对话中可用。

### 避免重复注册工具

为避免在 Skill 之外同时加载原生 MCP 工具目录，请禁用（或删除）Codex 中直接连接 MCP 的配置：

```toml
[mcp_servers.resharper]
url = "http://127.0.0.1:23741/"
enabled = false
```

Skill 会先检查 Rider 和已打开的解决方案，只加载与导航、诊断或重构相关的必要指引，然后获取所选工具的 schema 并调用该工具。

### 安全与故障排查

随附的客户端将全部 6 个源码修改工具视为写操作。除非传入 `--apply`，否则客户端会阻止这些工具执行；`rename_symbol` 和 `apply_suggestions` 除外，在省略 `--apply` 时，它们会自动以 `dryRun=true` 运行。

排查问题时，可以直接运行客户端：

```bash
node skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs status
node skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs solutions
node skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs schema find_usages
node skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs call search_symbol --arguments-json '{"query":"MyType"}'
```

可通过 `--url` 或 `RESHARPER_MCP_URL` 使用自定义端点，通过 `--timeout-ms` 或 `RESHARPER_MCP_TIMEOUT_MS` 设置自定义请求超时时间。

## 构建

```bash
# 构建 .NET 后端
dotnet build src/ReSharperMcp/ReSharperMcp.csproj -c Release

# 构建可分发的插件 ZIP
./build-plugin.sh
```

## 架构

- 作为 ReSharper `SolutionComponent` 运行（打开解决方案时激活，关闭时停止）
- 在 `127.0.0.1:23741` 上托管 HTTP 服务器，通过 JSON-RPC 2.0 实现 MCP
- 使用 ReSharper PSI（Program Structure Interface，程序结构接口）API 进行代码分析
- Rider 插件由两部分组成：最小化的 JVM JAR（插件描述符）和 .NET 后端 DLL
- 以 `net472` 为目标框架（ReSharper 宿主进程要求）
