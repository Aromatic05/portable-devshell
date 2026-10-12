# Extension Database Capability

Extension 声明 `database` capability 后，通过 `context.capabilities.database` 使用 Host 持有的 SQLite 数据库。业务 Schema、SQL、迁移与数据模型仍归 Extension 所有；Host 持有物理连接、事务与 Generation 生命周期。

## Access 和 Ownership

- **Extension**：在 `devshell-extension.json` 的 `capabilities` 数组中声明 `"database"`；未授权调用直接失败。
- **Host**：为每个 Extension Generation 建立私有 Database Runtime；`open("instances/a/message")` 只会访问该 Extension `dataDirectory/instances/a/message.sqlite3`。不能传绝对路径或跨 Extension 访问。
- **Sandbox**：只持有不透明连接和事务标识；实际 `DatabaseSync` 始终在 Host。Extension 无权通过 Capability 打开任意本机数据库。
- **Lifecycle**：Extension 在 `deactivate` 时应关闭连接；即使异常或热替换失败，Host 仍回收属于该 Generation 的全部连接并回滚未提交事务。

## Contract

```ts
const capability = context.capabilities.database;
if (!capability) throw new Error("database capability is required");
const database = await capability.open("metadata");
await database.exec("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT)");
await database.transaction(async (tx) => {
    await tx.run("INSERT INTO metadata(key, value) VALUES (?, ?)", ["name", "example"]);
    const row = await tx.get<{ value: string }>(
        "SELECT value FROM metadata WHERE key = ?", ["name"],
    );
    if (row?.value !== "example") throw new Error("transaction invariant violated");
});
await database.close();
```

`get/all/run` 使用参数化 SQL，参数与结果支持 JSON 标量（有限安全范围数字、字符串、`null`）。`exec` 用于不带参数的 SQL。事务作用于单个连接且不支持嵌套；**事务回调必须使用传入的 `tx`，不要在其中等待外层连接的排队查询**。回调抛错会回滚；提交出错会回滚并废止该连接。

为防止跨数据库权限绕过，Host 拒绝 SQLite `ATTACH/DETACH`、未经租约的事务指令，以及 `VACUUM INTO` 写外部数据库。数据库权限不等同于任意文件写入权限。

Extension Sandbox 消息上限为 16 MiB。调用方应给大型 `all` 查询分页；Comment 使用最大 128 行的批次。

Host Database Capability 要求 Node.js **v24.12.0 或更新版本**，因为 SQLite `setAuthorizer` 自 v24.10.0 才有、`enableDefensive` 自 v24.12.0 才有。较旧运行时会拒绝打开数据库，不会降级成无路径约束的连接。

## Existing Storage

- Comment 消息：沿用 `extension-data/comment/instances/<encoded-instance>/message.sqlite3` 的旧文件路径，保持表结构和 v1 → v2 迁移行为。
- Comment Preferences：从旧 `message-preferences.json` 非破坏性导入到 Extension 自己的 `message-preferences.sqlite3`。
- Agent Provider Registry：从旧 `providers.json` 非破坏性导入到 Extension 自己的 `providers.sqlite3`。
- Storage Downgrade：管理员指定输入、输出路径的离线恢复工具不属于普通 Extension 数据库 Scope。需要无 Permission Model 的原有独立 `devshell-storage` 入口。

Node 26 的 Permission Model 会拒绝 `fsyncSync` 和 `FileHandle.sync`，所以持久化状态通过 Host-managed SQLite 完成，不应捕获同步异常后跳过落盘保证，也不应去掉 Extension Sandbox 的 `--permission`。
