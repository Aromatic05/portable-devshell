# 文件读取与编辑

`file_*` 的模型输入接受 workspace 裸相对路径并归一化为 `./...`。例如 `src/lib.rs` 等价于 `./src/lib.rs`；`.` 归一化为 `./`。绝对路径仍使用平台原生绝对路径。`..`、`././...`、`~/...` 等含糊或越界写法仍按 `file.invalidPath` 拒绝，底层路径安全规则不放宽。

## `file_read`

`file_read` 批量读取文件正文、结构或路径元数据。正文和 outline 读取在当前 worker instance 与 `ctxId` 内建立隐式编辑快照；metadata 只观察文件系统状态，不建立编辑 coverage。调用方不需要复制 snapshot ID、tag 或 revision。

输入：

```json
{
    "files": [
        {
            "path": "./src/lib.rs",
            "view": "content",
            "selector": "50-100"
        }
    ]
}
```

`view` 可以省略，默认是 `auto`：

- 小文件返回完整 `content`。
- 较大的受支持源文件返回 Tree-sitter outline。
- 其他较大文件返回前 200 行正文。

可选模式：

```text
auto
content
metadata
outline
```

`metadata` 不跟随最后一级符号链接，并允许路径不存在。它返回稳定的 `exists` 布尔值，以及存在时的 `type`、`sizeBytes`、`modifiedAtMs`、`mode` 和可选 `targetType`。`type` / `targetType` 取值为 `file | directory | symlink | other`。metadata 不接受 `selector`。

输出中的 `view` 始终是实际解析后的 `content`、`outline` 或 `metadata`，不会返回 `auto`。

`bash_run` 还可能返回 `/.devshell/tool-results/<id>/stdout` 或 `/.devshell/tool-results/<id>/stderr`。这些是 Worker 内部 ResultStore 的只读虚拟路径，不是宿主绝对路径，也不要求 `AbsoluteRead` 权限。`file_read` 对它们支持 `auto` / `content` 和相同的 selector 分页，但不支持 `metadata` / `outline`，也不会建立 `file_edit` snapshot/coverage。引用受内部 ArtifactStore TTL 与配额约束；过期后按 `file.notFound` 处理。

`content` selector 使用一基行号：

```text
50
50-100
50+100
5-16,960-973
50-100:raw
raw
```

多个显式范围可以乱序、重叠或相邻；Worker 会先排序并合并。结束行超过 EOF 时自动截到文件末尾；起始行已经超过 EOF、反向范围或非法行号仍返回 `file.invalidRange`。Batch 中单个 path 的 `notFound`、`notFile`、`invalidRange`、`outlineUnavailable` 等读取错误不会丢掉其他成功项，而是写入该项的 `error` 字段。

outline 返回符号的起止行、层级、语言和 `parseStatus`。outline 不使用正文分页式 `nextSelector`；根据符号范围再次调用 `view=content` 即可读取实现。

## `file_glob`

`file_glob` 按 exact path 或 glob pattern 查找文件和目录，并支持 `file` / `directory` / `any` 类型过滤。第一页使用 `patterns`：

```json
{
    "patterns": ["./src/**/*.ts", "./packages/*/package.json"],
    "type": "file"
}
```

不存在的 exact path 和不存在的 glob root 都是合法的 discovery miss，返回空结果而不是把整个 tool call 标记为 `file.notFound`。多个 pattern 中某个目标缺失也不会影响其他 pattern 的结果。

每页最多返回 200 个 entry。出现 `nextCursor` 时，cursor 保存实际 traversal continuation，包括目录 DFS 栈、当前 entry index、ignore 规则、类型过滤条件和去重状态。下一页只传 `cursor`，不再重复 `patterns`、`type`、`hidden` 或 `gitignore`；它会从上次停止的位置继续，而不是重新遍历根目录。

Cursor 绑定当前 `ctxId + workspace + worker process`，并受 LRU 容量限制。续页响应如果丢失，原 cursor 仍可重试；只有当调用方实际使用由它派生出的后续 `nextCursor` 时，旧 cursor 才会被回收。跨 Context/workspace 使用、worker restart 或 cursor 被淘汰后返回 `file.invalidCursor`；此时重新发起原始查询即可。

所有输入 path / glob root 会在第一页先完成解析、权限和基础合法性检查；continuation 只延迟递归 traversal 本身，不延迟输入错误。

Traversal 使用已经解析并锚定的目录能力。因此第一页之后即使路径名被替换，后续 cursor 仍沿着原来已经打开的目录树继续，而不会静默切换到新目标。

## `file_grep`

`file_grep` 在 exact file、目录或 glob 中搜索 UTF-8 文本：

```json
{
    "paths": ["./src"],
    "pattern": "TODO",
    "syntax": "literal",
    "context": 2
}
```

不存在的搜索 path 贡献 0 个匹配，不会拖垮其他搜索根。`syntax` 省略时仍优先按 regex 解释；如果 pattern 无法编译成 regex，则自动按 literal 重试。显式 `syntax="regex"` 时保持严格，非法表达式仍返回 `file.invalidRegex`。

一页最多返回 20 个匹配文件。与 `file_glob` 相同，`nextCursor` 保存完整 discovery/search continuation；下一页只传 `cursor`，此时不得重复 `pattern`、`paths`、`syntax`、`caseSensitive`、`hidden`、`gitignore`、`context` 或 `startLine`。它会继续扫描尚未访问的候选文件。恰好一页结束时已经没有更多匹配，则不会额外返回一个只会产生空页的 cursor。

为了约束单个文件的返回规模，每个文件最多展示：

```text
exact single-file search   200 matches
directory/glob search       20 matches per file
```

达到上限本身不代表发生信息损失；只有文件中确实存在更多匹配时，该结果才显式返回：

```json
{
    "path": "./src/large.rs",
    "content": "...",
    "truncated": true,
    "nextLine": 841
}
```

`nextLine` 是第一条未展示的匹配行。继续该文件时，重新对这个 exact file 搜索并传 `startLine=nextLine`。`startLine` 只用于一个 exact file，不用于目录或 glob。这样“只展示前 N 个匹配”和“总共恰好 N 个匹配”不会被混淆，也不会出现知道有遗漏却无法继续读取的断头结果。

搜索结果还受 RPC 序列化输出预算约束。因为预算而留到下一页的文件不会提前建立编辑快照；只有本次真正出现在 `files` 数组中的源码行才算已经被 agent 观察，并进入 `file_edit` coverage。

### 旧 MCP 名称兼容

`0.7.2` 引入新名称后，缓存旧 schema 的 MCP 客户端仍可在 `0.7.2` 和 `0.7.3` 调用 `file_find`、`file_search`、`file_info`。这些旧名称不会继续出现在新的 `tools/list`：`file_find` 映射到 `file_glob`，`file_search` 映射到 `file_grep`，`file_info` 映射到 `file_read view=metadata` 并保持旧输入/输出 shape。兼容入口在 `0.7.4` 删除。

## 隐式快照

快照按以下边界隔离：

```text
worker instance + ctxId + normalized path
```

以下调用会建立或更新快照：

```text
file_read
file_grep
成功的 file_edit 子操作
```

MCP/RPC transport session 关闭不会清理 Context 快照；重连后只要仍解析到同一个内部 `ctxId` 就可以继续使用。`file_grep` 只为本次实际返回在 `files` 数组中的结果建立或更新快照，分页之外或因输出预算未返回的匹配文件不会获得快照。`file_read view=metadata` 不建立快照。没有快照时，修改已有文件返回 `file.snapshotRequired`。Patch 使用未读取的源码行时返回 `file.unreadRange`。

## `file_edit`

`file_edit` 是唯一公开写工具，输入一个有序 change set：

```json
{
    "changes": "*** Begin Edit\n*** Write File: ./src/new.rs\n...\n*** End Edit"
}
```

支持五种子操作：

```text
Write File
Patch File
Rewrite File
Delete File
Move File
```

Canonical 方言仍然是 `*** Begin Edit` / `*** End Edit` 与上述五种 section。为兼容常见 coding-agent 先验，parser 同时接受 `*** Begin Patch` / `*** End Patch`、`*** Update File:`（等价于 `Patch File`）以及 `*** Add File:`（等价于 `Write File`）。Codex 风格 `Add File` 中每行统一的 `+` 前缀会被去除。

### Write File

只创建不存在的文件。正文是原样 UTF-8 文本，不使用 `+` 前缀：

```text
*** Write File: ./src/new.rs

pub struct NewModule;
```

目标父目录必须已经存在。

### Rewrite File

完整覆盖已存在且已读取的文件：

```text
*** Rewrite File: ./src/generated.rs

// generated
pub const VERSION: usize = 2;
```

revision 由 context 快照自动校验。Rewrite 不进行三方合并。

### Patch File

对已存在且已读取的文件应用精确 context patch：

```text
*** Patch File: ./src/lib.rs
@@
 mod old_module;
+mod new_module;
```

Patch 行前缀：

```text
空格  context
-     删除
+     新增
```

文件头和文件尾插入：

```text
@@ BOF
+use std::sync::Arc;

@@ EOF
+mod tests;
```

所有 hunk 都在同一原始快照中定位，必须精确且唯一，不进行模糊匹配。完整快照遇到非冲突外部修改时可以三方合并；稀疏快照 revision 变化时要求重新读取。

### Delete File

```text
*** Delete File: ./src/unused.rs
```

目标必须存在并已读取；删除前自动校验 revision。

### Move File

```text
*** Move File: ./src/old.rs
*** To: ./src/new.rs
```

源文件必须存在并已读取，目标必须不存在，目标父目录必须存在。Move 只使用同一文件系统内的原子 no-clobber rename；不退化成复制后删除。

## 执行语义

完整 change set 先进行解析、权限、路径和快照静态预检。对于包含多个子操作的 change set，Worker 还会在虚拟文件状态中完整进行语义预演：Patch 定位、coverage、revision/merge、Write/Move/Delete 的目标关系以及调用内依赖全部通过后，才开始真实写盘。因此这些可预见的语义错误保证 workspace **0 落盘**；失败 section 返回 `failed`，其余 section 返回 `notExecuted`。

进入真实 commit 后仍按 section 顺序执行，每个单文件子操作自身原子；若发生磁盘 I/O、权限、设备故障等 OS 级错误，则立即 fail-stop，后续 section 标记为 `notExecuted`，已经提交的 section 可能保留。当前语义因此是 **semantic atomicity**，不是文件系统级多文件 ACID 事务。单文件 Write/Patch/Rewrite 继续使用临时 sibling + revision CAS + 原子发布；如果未来需要强化物理 commit 原子性，应增加 staging/rollback journal，而不是改回 best-effort continue。

同一 change set 内可以依赖前面的结果：

```text
Write A
Patch A
Move A -> B
Patch B
```

这些依赖使用调用内局部快照链，不会在子操作之间误用其他并发调用发布的新快照。

## 取消语义

`file_read`、`file_glob` 和 `file_grep` 会在目录遍历、文件读取及结果组装的安全点响应取消。

`file_edit` 的取消是协作式的：解析、静态预检以及多操作 change set 的语义预演阶段可以直接停止且不会写盘；开始真实执行后只在子操作边界检查取消。当前正在进行的原子 Write/Patch/Rewrite/Delete/Move 不会被截断，先前已经成功提交的子操作也不会回滚。取消发生后，当前 section 返回取消错误，后续 section 标记为 `notExecuted`。

## 正文中的控制标记

Write/Rewrite 只在行首遇到完整控制行时结束，例如：

```text
*** Patch File:
*** Update File:
*** Add File:
*** Rewrite File:
*** Delete File:
*** Move File:
*** End Edit
*** End Patch
```

普通 `***` 文本没有特殊含义。文件内容本身需要包含完整控制行时，使用 `Patch File`，新增行的 `+` 前缀会消除 envelope 歧义。
