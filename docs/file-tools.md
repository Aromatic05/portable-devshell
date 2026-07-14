# 文件读取与编辑

## `file_read`

`file_read` 读取 UTF-8 文本，并在当前 worker instance 与 MCP/RPC session 内建立隐式编辑快照。调用方不需要复制 snapshot ID、tag 或 revision。

输入：

```json
{
  "path": "./src/lib.rs",
  "view": "auto",
  "selector": "50-100"
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
outline
```

`content` selector 使用一基行号：

```text
50
50-100
50+100
5-16,960-973
50-100:raw
raw
```

outline 返回符号的起止行、层级、语言和 `parseStatus`。outline 不使用正文分页式 `nextSelector`；根据符号范围再次调用 `view=content` 即可读取实现。

## 隐式快照

快照按以下边界隔离：

```text
worker instance + RPC/MCP session + normalized path
```

以下调用会建立或更新快照：

```text
file_read
file_search
成功的 file_edit 子操作
```

MCP session 关闭后，对应快照会被清理。没有快照时，修改已有文件返回 `file.snapshotRequired`。Patch 使用未读取的源码行时返回 `file.unreadRange`。

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

revision 由 session 快照自动校验。Rewrite 不进行三方合并。

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

完整 change set 先进行解析、权限、路径、Patch 和快照预检。预检失败保证零修改。

随后按 section 顺序执行：

```text
每个子操作自身原子
首个运行期失败后停止
先前成功的操作保留
后续操作标记为 notExecuted
```

同一 change set 内可以依赖前面的结果：

```text
Write A
Patch A
Move A -> B
Patch B
```

这些依赖使用调用内局部快照链，不会在子操作之间误用其他并发调用发布的新快照。

## 取消语义

`file_read`、`file_find`、`file_search` 和 `file_info` 会在目录遍历、文件读取及结果组装的安全点响应取消。

`file_edit` 的取消是协作式的：解析和完整预检阶段可以直接停止；开始执行后只在子操作边界检查取消。当前正在进行的原子 Write/Patch/Rewrite/Delete/Move 不会被截断，先前已经成功的子操作也不会回滚。取消发生后，当前 section 返回取消错误，后续 section 标记为 `notExecuted`。

## 正文中的控制标记

Write/Rewrite 只在行首遇到完整控制行时结束，例如：

```text
*** Patch File:
*** Rewrite File:
*** Delete File:
*** Move File:
*** End Edit
```

普通 `***` 文本没有特殊含义。文件内容本身需要包含完整控制行时，使用 `Patch File`，新增行的 `+` 前缀会消除 envelope 歧义。
