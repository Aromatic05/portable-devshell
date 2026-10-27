# Version 与 Compatibility Lifecycle

原始源码审计基线提交 `2287310a` 的产品版本为 **`1.0.0-beta.1`**；`1.0.0-rc.1` 为首个 Release Candidate 候选版本；发布后开发分支会自动进入下一开发版本。历史 `0.x.y` 中的 `y` 是同一开发世代的发布序号，不承担 SemVer patch 语义；`0.7.x` 是当时面向 1.0.0 的收敛阶段，不是当前开发版本。历史 release note 与 release interval 保持原有语境。

产品版本不能替代各 public contract 自己的版本。一个 DevShell release 同时依赖多个彼此独立的 compatibility surface：

```text
DevShell release        1.0.0-rc.1
    Control Protocol    x.y.z
    Worker Protocol     x.y.z
    Frame Protocol      x.y.z
    Extension API       x.y.z
    Extension Schema    x.y.z
    Persistent Schema   domain-owned
```

这些版本只在对应 contract 发生变化时推进，不随 DevShell release 同步 bump。

### RC 候选实现（1.0.0-rc.1）

| Surface | 当前 representation | 源码 owner |
| --- | --- | --- |
| DevShell release | `1.0.0-rc.1` | 根 `package.json`（发布提交） |
| Control Protocol | semantic range `1.0.0`–`1.0.0` | `shared/src/control/server/Model.ts` |
| Worker Protocol | semantic range `1.0.0`–`1.0.0` | `shared/src/types/Worker.ts` / Rust RPC codec |
| Frame Protocol | semantic range `1.0.0`–`1.0.0`；wire format v1 | `shared/src/transport/frame/Codec.ts` |
| Extension API | `5.0.0` | `extension/src/ExtensionManifest.ts` |
| Extension Schema | `1.1.0` | `extension/src/ExtensionManifest.ts` |
| Persistent Schema | domain-owned；例如 instance config v4、Context v2 | 各 domain codec/migration |

表中 TS owner 路径相对 `packages/`。当前不再承诺 legacy Control integer `1`、Worker `7` 或 Frame no-negotiation adapter；不能从旧发布记录推导当前 admission。Extension manifest 的 `apiVersion` / `schemaVersion` 必须为 `x.y.z` 字符串，同 major 且 requested 不高于 Host，不接受旧整数写法。

历史 `0.7.6` release note 描述当时的 integer Control / Frame contract；`0.7.7` interval 记录当时的语义版本冻结工作。这些历史结论不应被改写成当前版本现状，也不意味着重新接受已删除 adapter。下文 release interval 规则与 live compatibility checker 仍有效。

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

Control Protocol、Worker Protocol 与 Frame Protocol 是独立协议，不共享一个总版本号。当前协议版本统一使用 `x.y.z`：

```text
x    incompatible protocol generation
y    backward-compatible protocol capability
z    compatible correction or clarification
```

已经迁移到语义版本的协议，连接双方必须显式声明自己可接受的协议范围，并选择共同支持的最高版本。版本协商只决定 contract generation；具体可选能力仍通过 capability negotiation 表达，不能通过猜测 peer 的产品版本来开启功能。

同一 major 不代表任意版本天然兼容。只有落在双方声明的 supported range 内才允许建立连接。没有共同版本时必须在握手阶段失败，不能降级到未声明的兼容路径。

当前 Control、Worker 与 Frame 都使用独立的 `x.y.z` supported range。Worker client 会验证 Worker 返回的 negotiated version 落在自己声明的 range 内；Control hello 同样拒绝无交集的 semantic range。Frame 的 semantic Protocol version 与 packet header 中的 wire-format generation 分离：当前 semantic version 为 `1.0.0`，现有 packet wire format 仍是 v1，因此冻结 semantic negotiation 不要求重写已有 Frame 编码。

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
Context.ts    Context state migration
Audit.ts      Audit state migration
```

这是集中迁移编排的边界；配置迁移仍经 `ControlConfigStore.migrate()` / `inspectMigration()` 处理，不应把已不存在的 `migration/Config.ts`、`Wait.ts` 当作当前入口。新迁移应归实际 domain owner，并通过统一 lifecycle 调用。Extension 自己拥有的 persistent schema migration 则放在该 Extension 自己的 `migration/` 目录，不上收进 Control。

维护旧 schema 时按 migration window 管理，而不是永久累积 compatibility code。提高 minimum readable schema 后，应在同一变更中删除对应 migration implementation 与旧版本行为测试，并同步移除 decoder 对该旧版本的 admission。这样历史兼容代码可以按支持窗口直接审计和删除，而不会散落在 Store / State / runtime 主路径中。

## Compatibility expiry

兼容实现统一在其逻辑 owner 处使用稳定 slug 标记：

```text
@compat <stable-slug>
```

长期稳定兼容只需要 `@compat`。仍属于 compatibility debt、计划在维护窗口内删除的临时兼容再附加：

```text
@compat <stable-slug>
@removeAt x.y.z
```

TypeScript/JavaScript 使用普通 source comment/JSDoc，Rust 使用 `//`，shell/PowerShell 使用 `#`。一个逻辑兼容面只要求 owner annotation，不要求每个调用点重复标记；跨语言拥有独立实现时可以重复使用同一个 `@compat` slug。

`@removeAt` 是可选的 maintenance deadline，不是 persistent schema 或 public protocol 的 compatibility contract。当它存在且当前 DevShell version **大于或等于** `@removeAt` 时，`scripts/check-compat-expiry.mjs` 必须失败。没有 `@removeAt` 的 `@compat` 表示已经确认长期支持，不参与 expiry。

checker 中的 maintenance policy 仍以 **`0.7.10`** 为硬截止；checker 同时拒绝任何晚于 `0.7.10` 的 `@removeAt`。Deadline 可以提前，但不能向后移动。到期前必须真正解决：删除临时兼容实现与对应旧行为测试，或者在确认它本来就应该长期支持时把该行为纳入稳定 compatibility contract 并移除 `@removeAt`。不能通过改成 `0.7.11`、`1.0.0` 或其他更晚版本绕过门禁。

当前入口：

```text
pnpm compat:check    fail on expired/invalid annotations
pnpm compat:list     list stable compatibility and expiring debt
pnpm version:check   product version gate + compatibility expiry gate
```

Compatibility expiry 同时进入 development CI、final acceptance 与 release gate。`dist/`、`target/`、`node_modules/` 等生成物不参与扫描，避免编译产物复制 source comments 后产生重复债务记录。

对于 persistent migration，是否还能读取旧数据仍由 `minimum readable schema` 决定；`@removeAt` 约束的是旧 migration implementation 必须在 deadline 前完成生命周期处理。对于外部协议或输入方言兼容也是一样：如果审查后决定长期支持，应移除 `@removeAt` 并保留稳定 `@compat` owner，而不是延期 compatibility debt。

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

Compatibility preflight 当前至少检查：

```text
Control / Worker / Frame protocol range
required migration paths
installed Extension API / schema compatibility
Extension host dependency ranges
rollback feasibility
```

`0.7.6` 发布时的 `devshell update` preflight 已检查 persistent config migration requirement、已安装 Extension generation 的 manifest/API/schema compatibility，以及 Extension `hostDependencies`。该工作在历史 `0.7.7` interval 继续扩展；当前 beta.3 会读取 application generation 的 Control / Worker / Frame contract，与 candidate supported range 做交集检查，不根据产品版本猜测协议，也不承诺已删除的 legacy adapter。range 不相交是 live peer 兼容性诊断，不直接否决已停机程序的替换；未提供 current generation range 时返回 `current: null`，不能把它当成已验证两代可同时通信。

Preflight 现在也显式返回 rollback feasibility。若 candidate 需要 persistent migration，则结果标记 `rollback.feasible = false` 并给出 `persistentMigrationRequired` blocker：这不会阻止升级本身，但表示 migration 一旦提交，installer 不再自动降级到旧 generation。Release installer transaction 仍单独负责 artifact validation、backup、candidate install/start validation 和失败 rollback 的实际执行。

`devshell migrate` 与 `devshell update` 在实现上分离，在默认升级流程中组合。这样 migration 可以独立用于恢复、离线迁移和手工安装，而 update 不需要拥有第二套 migration 规则。

## 1.0.0 稳定版目标

以下是稳定版的冻结目标，当前 beta.3 不能仅凭产品版本就宣称全部验收完成：

```text
Control Protocol versioning rules frozen
Worker Protocol versioning rules frozen
Frame Protocol versioning rules frozen
Extension API lifecycle frozen
Extension manifest lifecycle frozen
Persistent migration policy frozen
Update / migrate transaction boundary frozen
```

历史 `0.7.x` 曾允许通过多个发布版本逐步收敛 contract；当前 beta.3 不再属于该版本线。此前已声明冻结的 contract 在 beta 与后续发布中仍必须遵守各自的 compatibility rule。
