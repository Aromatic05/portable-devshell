# Core Domain 组织规范

本文只约束 `packages/core` 中 domain 的通用骨架。除下述规则外，不对 domain 内部继续施加统一的文件分类、分层或命名限制；具体组织应由该 domain 自身的实体关系与职责决定。

## Domain 根目录

每个 domain 根目录必须包含 `index.ts`。

`index.ts` 表示该 domain 的生命周期持有者，也是该 domain 最终的挂载点。domain 内部对象的创建、持有、组合与生命周期应最终能够收敛到这里。

domain 根目录还可以按实际需要包含以下文件：

- `Api.ts`：domain 对外可使用的类型。
- `Public.ts`：domain 对外可调用的函数或能力。
- `Route.ts`：描述从当前 host 外部如何访问该 domain。

这些文件都是可选的。只有存在对应职责时才创建，不要求每个 domain 为了形式统一而补齐。

例如：

```text
domain/
├── index.ts
├── Api.ts
├── Public.ts
├── Route.ts
└── ...
```

## Route

`Route.ts` 的语义固定为：从当前 host 外部如何访问该 domain。

当 route 本身已经形成一个需要独立组织的实体时，可以由单文件提升为目录：

```text
domain/
├── index.ts
└── route/
    ├── index.ts
    └── ...
```

是否使用 `Route.ts` 或 `route/` 由实际实体关系决定，不以文件数量或代码行数作为统一判据。

## 目录入口

domain 内的实体目录必须包含 `index.ts`，组合目录不要求包含 `index.ts`。

实体目录围绕一个明确的对象组织，目录内的其他文件服务于该对象的状态、行为或内部组成。其 `index.ts` 是该实体的实现入口或中心文件，应由实际的中心实现承担，而不是仅汇总导出目录中的文件。

组合目录用于组织多个独立实体或并列实现，目录本身不对应一个实体，不需要为了入口而创建额外对象或汇总导出文件。不能仅凭文件数量、相关对象集合或“子系统”的名称认定实体目录。

只有 domain 根目录的 `index.ts` 被赋予“domain 生命周期持有者 / 挂载点”的固定语义。实体子目录的 `index.ts` 的具体职责由该实体自身决定。

例如：

```text
domain/
├── index.ts
├── provider/       # 组合目录：并列实现，不要求 index.ts
│   ├── Local.ts
│   └── Ssh.ts
└── route/
    ├── index.ts
    └── ...
```

## 约束边界

除此之外，不定义更多通用的 domain 内部组织规则。

尤其不因为统一风格而强制创建额外层级、固定子目录集合，或要求所有 domain 拥有相同的内部结构。domain 的目录与文件应服务于实际实体关系和职责，而不是服务于模板本身。
