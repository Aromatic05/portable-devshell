# Version 与 Compatibility Lifecycle

portable-devshell 在 `1.0.0` 之前使用 `0.x.y` 产品版本。这里的 `y` 是同一开发世代中的发布序号，不承担 SemVer patch 的语义。当前 `0.7.x` 是面向 `1.0.0` 的长期收敛阶段，主要用于协议冻结、架构完善、API 查找与归纳，以及 Core / Extension 边界深化。

产品版本不能替代各 public contract 自己的版本。一个 DevShell release 同时依赖多个彼此独立的 compatibility surface：

```text
DevShell release        0.7.y
    Control Protocol    x.y.z
    Worker Protocol     x.y.z
    Frame Protocol      x.y.z
    Extension API       x.y.z
    Extension Schema    x.y.z
    Persistent Schema   domain-owned
```

这些版本只在对应 contract 发生变化时推进，不随 DevShell release 同步 bump。

## Protocol version

Control Protocol、Worker Protocol 与 Frame Protocol 是独立协议，不共享一个总版本号。协议版本使用 `x.y.z`：

```text
x    incompatible protocol generation
y    backward-compatible protocol capability
z    compatible correction or clarification
```

连接双方必须显式声明自己可接受的协议范围，并选择共同支持的最高版本。版本协商只决定 contract generation；具体可选能力仍通过 capability negotiation 表达，不能通过猜测 peer 的产品版本来开启功能。

同一 major 不代表任意版本天然兼容。只有落在双方声明的 supported range 内才允许建立连接。没有共同版本时必须在握手阶段失败，不能降级到未声明的兼容路径。

## Extension version

Extension API 与 Extension manifest schema 使用独立的 `x.y.z`。Host 只接受自己明确支持的版本范围；Extension 不得依据 DevShell 产品版本推断 ABI。

`hostDependencies` 属于 package dependency contract，不属于 Extension API version。Host 提供的 package 必须同时满足 Extension 声明的依赖名称和版本范围。

Extension 之间默认通过稳定的 Extension Point / Capability 交互。只有出现真实需求时才引入 Extension -> Extension dependency，不能把实现之间的直接依赖当作默认组合机制。

## Persistent schema

持久化数据由各 domain 自己拥有 schema version。Migration 判断依据是 persistent schema，而不是 DevShell release number：

```text
current schema
minimum readable schema
migration path
```

Migration 应直接把仍受支持的旧 schema 转换到 current schema；不要求按历史 DevShell release 顺序逐个启动旧版本。

普通启动负责检测和验证 persistent schema。不可逆 migration 不应作为普通启动的隐式副作用。显式 migration 由统一的 migration lifecycle 承担，并由 `devshell migrate` 提供 CLI 入口。

当 schema 早于当前 binary 的 minimum readable schema 时，必须明确拒绝并报告缺失的 migration path。

## Update lifecycle

`devshell update` 是现有 release installation transaction 的产品入口，不建立第二套 installer。标准升级流程为：

```text
resolve target release
    -> validate artifact
    -> compatibility preflight
    -> prepare rollback
    -> install candidate generation
    -> migrate persistent state
    -> start and validate candidate
    -> commit or rollback
```

Compatibility preflight 至少检查：

```text
Control / Worker protocol range
required migration paths
installed Extension API / schema compatibility
Extension host dependency ranges
rollback feasibility
```

`devshell migrate` 与 `devshell update` 在实现上分离，在默认升级流程中组合。这样 migration 可以独立用于恢复、离线迁移和手工安装，而 update 不需要拥有第二套 migration 规则。

## 1.0.0 freeze

`1.0.0` 的稳定含义不是内部实现不再变化，而是 compatibility lifecycle 已经稳定：

```text
Control Protocol versioning rules frozen
Worker Protocol versioning rules frozen
Frame Protocol versioning rules frozen
Extension API lifecycle frozen
Extension manifest lifecycle frozen
Persistent migration policy frozen
Update / migrate transaction boundary frozen
```

`0.7.x` 可以持续多个发布版本来完成这些 contract 的发现与收敛；已经声明冻结的 contract 在 `0.7.x` 后续版本中也必须遵守自己的 compatibility rule。
