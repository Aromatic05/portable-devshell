# 验收说明

这份文件只记录当前可执行的验收入口，不再保存容易失真的静态“已通过”结论。Release 以构建与打包成功为硬门禁；测试由独立 CI job 报告，不阻止已经成功构建的发布产物输出。

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
- CI 的 `build` job 必须成功并上传应用构建产物；
- CI 的 `test` job 运行完整验收，失败会被报告，但不参与 Release 门禁；
- `v*` 正式 tag 触发 Release，仅在应用包和四个平台 worker 全部构建成功后发布。

## 发布前检查

发布前至少确认：

1. 全局配置版本仍为 `1`，实例配置版本仍为 `2`；
2. 所有实例配置示例都使用 `[mcp.tools]` 的工具组与能力模型；
3. `pnpm install:local` 优先下载并安装四个平台的 Release worker，只对缺失 target 使用本地构建回退；
4. 发布安装器下载、校验并安装四个平台 worker，而不是只安装 control 主机 target；
5. Release 同时包含应用包、安装脚本和四个平台的 worker；
6. Linux 与 macOS 在没有手动设置 `XDG_RUNTIME_DIR` 时都能解析 control socket；
7. 默认 MCP 策略不包含 `instance` group 和 `manage` capability；
8. 启用 `instance + manage` 时，实例管理工具和跨实例路由行为经过测试；
9. 公网 MCP 在无认证时被拒绝。
