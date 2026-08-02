# 验收说明

这份文件只记录当前可执行的验收入口，不再保存容易失真的静态“已通过”结论。正式 Release 既要求同一提交的开发 CI 全部成功，也要求六个原生目标的应用包与 Worker 构建成功；开发 CI 中的测试失败会阻止 Release 门禁通过。

## 完整验收

```bash
bash acceptance/run-final-acceptance.sh
```

该脚本依次执行：

```text
pnpm build
pnpm typecheck
cargo build --locked --workspace
pnpm test
cargo test --locked --workspace
bash acceptance/run-real-worker-smoke.sh
bash acceptance/run-mcp-smoke.sh
```

## 分项验收

```bash
bash acceptance/run-typecheck.sh
bash acceptance/run-unit-tests.sh
bash acceptance/run-real-worker-smoke.sh
bash acceptance/run-mcp-smoke.sh
```

## CI 与 Release 触发规则

- 普通分支和 `main` 的直接 push 不触发 CI；
- PR、手动运行和 `dev*` 预发布 tag 触发 CI；
- CI 的六目标 `verify-target` 矩阵必须全部成功，并分别上传对应目标的应用包与 Worker；
- 每个目标都执行脚本测试、Lint、构建、类型检查、Rust/TypeScript 测试、Worker/客户端 smoke 和安装包 smoke；Linux x64 额外执行完整验收；
- Release 工作流在构建任何正式资产前，会验证同一提交对应的开发 CI 已成功，因此测试失败会阻止正式发布；
- `v*` 正式 tag 触发 Release，仅在六个原生目标的应用包和 Worker 全部构建成功后发布。

## 发布前检查

发布前至少确认：

1. 全局配置版本仍为 `1`，实例配置版本仍为 `2`；
2. 所有实例配置示例都使用 `[mcp.tools]` 的工具组与能力模型；
3. `pnpm install:local` 只预装当前主机的 Release Worker，并仅在该资产无法取得时尝试本地构建回退；
4. 发布安装器只预装当前 control 主机的 Worker，其他目标由 control 首次连接时按需下载并校验；
5. Release 同时包含六个原生目标的应用包与 Worker，以及 Unix、Windows 安装脚本；
6. Linux 与 macOS 在没有手动设置 `XDG_RUNTIME_DIR` 时都能解析 control socket；
7. 默认 MCP 策略不包含 `instance` group 和 `manage` capability；
8. 启用 `instance + manage` 时，实例管理工具和跨实例路由行为经过测试；
9. 公网 MCP 在无认证时被拒绝。
