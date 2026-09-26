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

### 0.7.6 当前状态

`0.7.x` 仍处于 contract 发现与冻结阶段，因此不能把目标态写成已经完成的现状。当前实现是：

| Surface | 0.7.6 representation | 状态 |
| --- | --- | --- |
| DevShell release | `0.7.y` | 当前产品版本规则 |
| Control Protocol | integer generation/range | 尚未迁移为 `x.y.z` |
| Worker Protocol | `x.y.z` range，当前 `1.0.0`；保留 legacy Worker 7 adapter | 已使用语义版本协商 |
| Frame Protocol | integer Frame v1 | 尚未迁移为 `x.y.z` range |
| Extension API | `x.y.z`，当前 `4.1.0` | 已使用语义版本 |
| Extension Schema | `x.y.z`，当前 `1.1.0` | 已使用语义版本 |
| Persistent Schema | domain-owned integer/schema version | 由各 domain 自己迁移 |

Control / Frame 的语义版本化属于后续 `0.7.x` freeze 工作，不是 `0.7.6` 已经提供的兼容承诺。

## Release interval version rule

任何一个 version field 在相邻两次 release 之间最多改变一次。

如果一个尚未 release 的 contract version 已经在当前 interval 中完成了唯一一次改变，后续属于同一 release 的 contract 收敛继续落在这个尚未发布的版本内，不能再次 bump。只有下一次 release 之后，才重新获得一次 version change 的机会。

因此版本演进遵循：

```text
release N
    -> version field may change once
    -> continue refining that unreleased contract without another bump
release N+1
    -> version field may change once again
```

这个规则适用于 DevShell release version、各 Protocol version、Extension API/schema version 和其他独立 version field。不能因为开发过程中又发现一个 contract change，就在同一个 release interval 内连续推进多个版本号。

## Protocol version

Control Protocol、Worker Protocol 与 Frame Protocol 是独立协议，不共享一个总版本号。冻结后的目标协议版本统一使用 `x.y.z`：

```text
x    incompatible protocol generation
y    backward-compatible protocol capability
z    compatible correction or clarification
```

已经迁移到语义版本的协议，连接双方必须显式声明自己可接受的协议范围，并选择共同支持的最高版本。版本协商只决定 contract generation；具体可选能力仍通过 capability negotiation 表达，不能通过猜测 peer 的产品版本来开启功能。

同一 major 不代表任意版本天然兼容。只有落在双方声明的 supported range 内才允许建立连接。没有共同版本时必须在握手阶段失败，不能降级到未声明的兼容路径。

`0.7.6` 中这套规则已经用于 Worker Protocol；Worker client 还会验证 Worker 返回的 negotiated version 是合法 `x.y.z` 且确实落在自己声明的 range 内。Control Protocol 与 Frame Protocol 仍使用各自现有的 integer generation contract，在完成后续迁移前不应把它们描述成已经具备上述 `x.y.z` range negotiation。

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

### Migration code ownership

Control 的 persistent migration 实现统一放在 `packages/control/src/migration/`：

```text
Control.ts    migrate / update preflight 编排
Config.ts     global / instance legacy config migration
Wait.ts       legacy Wait state migration
```

普通 storage、document codec、domain state 只能负责 current schema 与调用 migration entry；不能继续内嵌旧版本字段转换、legacy metadata 或一次性兼容修补。Extension 自己拥有的 persistent schema migration 则放在该 Extension 自己的 `migration/` 目录，不上收进 Control。

维护旧 schema 时按 migration window 管理，而不是永久累积 compatibility code。提高 minimum readable schema 后，应在同一变更中删除对应 migration implementation 与旧版本行为测试，并同步移除 decoder 对该旧版本的 admission。这样历史兼容代码可以按支持窗口直接审计和删除，而不会散落在 Store / State / runtime 主路径中。

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

完整 freeze 目标中的 Compatibility preflight 至少检查：

```text
Control / Worker protocol range
required migration paths
installed Extension API / schema compatibility
Extension host dependency ranges
rollback feasibility
```

`0.7.6` 的 `devshell update` preflight 当前已经检查 persistent config migration requirement、已安装 Extension generation 的 manifest/API/schema compatibility，以及 Extension `hostDependencies`。Release installer transaction 另外负责 artifact validation、backup、candidate install/start validation 和失败 rollback。

Control / Worker protocol range 的安装前 compatibility 判断，以及把 rollback feasibility 本身纳入显式 preflight result，仍是后续 `0.7.x` 工作。当前实现不能因为 installer 最终具有 rollback，就在文档中声称 preflight 已经完成这两项检查。

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
