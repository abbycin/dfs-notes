---
title: mace -- 架构设计
description: mace (mace-kv) 的架构设计和关键决策
pubDatetime: 2026-10-01
unlisted: true
tags:
  - mace-internal
---

这篇文章回答的问题是：mace 为什么是这个形状，以及每个形状的代价是什么。

- 想知道 mace 怎么用、多快，看 [README](https://github.com/abbycin/mace)
- 想改 mace 的代码，看 `docs/design.md`（流程规范）和 `docs/constraints/registry.yaml`（64 条不变式台账）
- 想判断一个改动该不该做，看这篇文章

## 设计目标与优先级

先说清楚 mace 不追求什么，因为不追求的东西比追求的更能约束设计。

mace 是嵌入式引擎，单进程，不做分布式，不做 SQL，不做多租户隔离，也不做跨节点的副本或共识。这些不是"以后再做"，而是明确排除：一旦引入节点间通信，前面所有关于崩溃窗口的推理都要重写。

在剩下的目标里，优先级是这样的：

1. **崩溃安全与数据不丢**。这是唯一不能妥协的。任何性能优化如果要求放宽持久化边界，直接否决。
2. **快照隔离的语义正确**。已提交事务在崩溃后必须仍然可见，已中止事务必须仍然不可见。
3. **吞吐与延迟**。在 1、2 不被破坏的前提下优化。参考 README 里的对比表。
4. **实现简单**。这条排最后，但它是个真实的约束：mace 的全部代码约 45k 行，规模上不允许引入复杂的分布式协议。

第 1 条的体现之一是 `Options::sync_on_write` 默认 `true`，也体现 graceful shutdown 时即使全程用的是宽松 WAL 模式，最后一次 checkpoint 仍然对所有输出文件做完整 fsync（`docs/design.md` 第 13 节）。正常运行时可以放松，退出时不能。

## 真正的难点在哪里

不是索引，不是事务，是**几个阶段之间的状态交接**。mace 里几乎所有难的地方都是"阶段 A 读到的值，在阶段 B 之后已经过期"这一类问题。

### checkpoint 切刀必须是一次原子的旋转

每个已加载的 bucket 维护两代脏数据：`hot` 接收当前变更，`sealed` 归当前正在发布的 checkpoint 所有。一次 checkpoint 触发时，要同时旋转一堆东西：脏页镜像及其字节计数、退休页血缘、新发现的垃圾地址、脏根、页 unmap 标记、进行中的写者根状态。这些必须一起切。

切歪了的后果是静默的数据丢失：如果一个写者跨越了切刀，它的页可能既不在 hot 也不在 sealed 里；如果一个 live 页在两代中都消失，checkpoint 会认为它已经被持久化，实际上它只是从内存里消失了。两种情况都不会报错，只会在下一次崩溃恢复或下一次读的时候暴露。对应约束是 `protocol.checkpoint_epoch_cut_atomicity`。

### GC 和 checkpoint 会同时修改同一份记账

垃圾回收的部分重写要挑 victim 文件、读它们的非活跃记录、生成替换文件、发布替换记账、然后删旧文件。与此同时 checkpoint 也在产生新的垃圾地址，也需要更新非活跃位图和文件统计。

难点在于"归属"：checkpoint 在重写期间新退休的逻辑地址，到底记到 victim 文件的旧统计上，还是记到替换文件的新统计上？mace 的做法是重写在读取非活跃状态之前就登记 victim 归属，checkpoint 在遇到 final victim 时重新解析逻辑地址、加载非活跃位图、更新旧统计并把地址挂到 collector 锁下；等到替换重定位完成，已经被复制的地址再转移到替换文件的记账上。归属状态只有在持久化元数据和运行时区间记账都指向替换文件之后才回到 idle。

这个交接如果做错，表现是空间泄漏或者统计为负，而且要跑很久才看得出来。对应 `protocol.stat_retirement_and_rewrite_junk_handoff`。

### abort-clean 不是 undo，是重写

中止的事务不能靠反向操作撤销，mace 的做法是把受影响的版本物理删掉，靠重写页面。这带来两个额外约束：重写完成后还需要等可能持有旧页镜像的读者排空，任务才能真正结束（WAL pin 在此之前一直保留）；另外，一个已经 unload 的 bucket 不会为了稳态 abort-clean 重新加载，它的任务保持 pending 并阻塞 unload/delete 完成。

### WAL 迁移的擦除范围

`sync_on_write` 和 `concurrent_write` 都是持久化选项，改值不会拒绝打开，而是走一次 epoch 迁移。麻烦在于旧纪元文件的分布：请求更宽的宽度时，目标宽度独占的流里可能残留上一次中断尝试留下的纪元文件。所以擦除范围不是 `[0, target)`，而是 `[0, max(source, target))` 并上磁盘上出现的所有 WAL namespace 并上 shared stream。redo 扫描和 group id 校验在擦除完成前保持在 source 宽度。

这条规则在 `docs/design.md` 第 9.1 和 9.3 节，是踩过坑之后写进去的。

### 外部依赖的原子性假设

mace 的元数据存在 btree-store 里，manifest publish 依赖 `btree-store` 的 `exec_multi` 把所有 bucket root 的变更作为一个 generation 发布，或者失败后旧 generation 仍然可见。这是一条外部依赖约束，目前在台账里是 `suspect` 状态，意思是很可能成立，但证据强度不足以当成 `active`。台账里另外两条 `suspect` 是 `protocol.map_and_frontier_publish_atomicity`（页表、区间/统计、bucket frontier、相关序列号必须在同一个 manifest 事务里发布）和 `protocol.data_blob_file_version_gate`（reader 必须拒绝未知的 footer 版本和该版本不支持的非零字段）。我把这些公开写出来，而不是等 review 的时候被人问。

## 概念与身份模型

mace 有四层身份，这个分层是理解整个系统的关键。

| 身份 | 含义 |
| --- | --- |
| bucket ID | 一个命名 bucket 的持久身份 |
| page ID | bucket 内部某个索引页的逻辑身份 |
| logical address | bucket 地址空间内某个持久记录的持久身份 |
| file ID | 一个 data、blob 或 WAL 文件的身份 |

解析一个已持久化的页要走三步：bucket 的 page table 把 page ID 映射到 logical address，bucket 的区间图把 logical address 映射到 data 或 blob 文件，文件的重定位表再把 logical address 映射到文件内的字节范围。

为什么要多这一层间接？因为 GC 重写改变物理位置但保持 logical address 不变。代价是每次持久化都要维护三张表（区间图、重定位表、每文件统计），换来的是页引用和 history 引用在文件重写前后完全稳定——这是 GC 能后台进行而不需要停写的前提。

持久化状态分四个域：metadata store（WAL 之外的一切账本）、WAL 文件（事务 redo 记录和 checkpoint hint）、data 文件（索引页和结构记录）、blob 文件（大 value）。其中 metadata store 是重建数据库的权威来源，data 和 blob 只有通过 metadata 发布才真正属于数据库。

运行时分三个域：前台事务和只读 view、bucket 运行时（索引、缓存、脏代、checkpoint 状态）、后台服务（checkpoint 完成、recovery、abort-clean、WAL 回收、payload GC、bucket 清理）。bucket 运行时是懒加载的，打开数据库不会把所有 bucket 的索引都拉起来。

## 借鉴与偏离

mace 的索引部分来自 Bw-Tree：不可变的页镜像加 delta 链更新，树变更发布新的页镜像而不是原地改持久页。delta 链长度达到 `consolidate_threshold` 时合并，这个阈值默认取 `split_elems / 2`（`split_elems` 默认 512，也就是默认 256），取值范围是 `[16, split_elems / 2]`。Bf-Tree 论文里的乐观锁耦合给了读路径的形状，仓库里对应 `src/utils/seqlock.rs`。

元数据层没有自己造轮子，用的是 btree-store。data/blob 文件格式是四个区：payload 帧、logical address 区间、重定位项、文件末尾的固定 footer。footer 记录格式版本和两张表的基数与校验和，是重开文件时的发现点。

下面这些是刻意偏离常见做法的地方：

- **abort-clean 用重写而不是 undo**。反向操作需要为每种操作类型实现逆运算，而且和版本历史叠加后很难证明正确。mace 选择写放大换简单。
- **merge operator 是纯运行时对象，永不持久化**。引擎只存运行时 handle，不存 operator 身份，跨进程重启的语义兼容性由调用方负责。这样避免了在磁盘格式里引入用户自定义类型的表达问题。
- **逻辑组和物理流是两个正交维度**。多数同类引擎只有一个"并发写宽度"维度，mace 把事务事实的归属和 WAL 文件命名空间拆开了。原因见下一节。
- **关闭 `sync_on_write` 时写入系统页缓存仍然算有效持久化**。这是选项的语义契约，不是 bug。

## 关键设计决策

这一节是全文的核心。每条决策我给出：备选方案、最终选择、理由、代价。

### 索引：为什么是 Bw-Tree 式的 delta 链

备选是 LSM 树（sled、RocksDB 那条路）和传统 B+Tree 原地更新。

选 Bw-Tree 式结构的理由有两条。一是 mace 需要非阻塞的并发读，页镜像不可变让读者不需要和写者协调；二是写者只做 delta 追加，避免了每次更新都触发页分裂或 LSM 的 compaction 风暴。

代价是读放大：一次点查要沿着 delta 链从新到旧遍历，直到找到快照可见的版本。这也是必须有 `consolidate_threshold` 的原因——链太长就合并。另外我早期在 photondb 上踩过一个坑：consolidation 如果不保证同一个 key 的所有版本落在同一个 node 上，Bw-Tree 的查找路由会出错，频繁更新的单个 key 会让某个 node 体积失控。mace 的处理是把版本历史放进 key 局部的 history region，由 history descriptor 记录首个 history 页、首个槽位和版本数，不同 key 可以共享 history 页但各自只在自己的声明范围内遍历。

### 身份与位置分离

备选是 page ID 直接映射到文件和偏移。

选四层身份的理由是 GC 重写必须能在不停止写入的前提下进行。如果页引用绑定物理位置，重写就要同时更新所有引用它的页，读者会看到撕裂的视图。分离之后重写只改区间图和重定位表。

代价是解析多两步，每次读页都要走完整条链路；另外所有引用必须始终用 logical address 而不是 file ID，这一点在代码里是硬要求，不是风格偏好。

### bucket 作为自治单元

备选是全局单一大索引，用 key 前缀区分 bucket。

选 bucket 自治的理由是让每 bucket 有独立的页地址空间、索引状态、checkpoint 代、持久 frontier、缓存策略、压缩策略和背压策略。这对混合负载很关键：一个大 value 的 bucket 和一个小 value 的 bucket 不该共享同一个 `inline_size`。

代价是全局服务仍然必须协调事务时间戳、WAL 流、recovery 和后台维护。而且 unload 只是运行时操作，绝不能削弱恢复语义或 abort-clean 语义——持久元数据和 payload 文件在 unload 期间完全不变。bucket 删除是两阶段的：先逻辑删除，物理清理放在后面，`nr_buckets` 只在物理清理完成后才递减。

### 脏数据两代与原子切刀

备选是单代脏集合加一个 checkpoint 锁，或者拷贝式快照。

选两代结构的理由是 checkpoint 期间写者不需要停。切刀一次旋转所有 checkpoint 输入，之后新写者用新的 hot 代，checkpoint 持有 sealed 代直到发布完成。

代价是内存峰值翻倍（hot + sealed 同时存在），以及切刀边界的推理成本。地址边界之后创建的页留在 hot 代或者被带到下一次 checkpoint，结构链接、退休血缘和 compaction 产生的垃圾仍然关联到仍然拥有其可达性的那一代。

### 数据先，元数据最后

这是 mace 唯一不可协商的持久化顺序，registry 里第一条约束就是它。对每个输出文件的流程是：

1. 持久化一个 orphan 标记
2. 构建文件
3. 同步文件以及需要的目录状态
4. 在元数据里一次性提交区间、重定位、统计、map/frontier 更新，并清除 orphan 标记
5. 发布新的运行时区间和记账状态

元数据提交之前，输出文件是孤儿，通过持久元数据不可达。元数据提交之后，它才是它所发布的 logical address 区间的权威持有者。

反例很直接：如果元数据先指向一个还没 fsync 的 payload 文件就崩溃，重启后元数据指向空洞，读会失败或读到垃圾，而系统认为数据是持久的。同一条规则在 epoch 迁移里也成立——目标纪元的文件必须有持久的目录项，`BUCKET_MISC/options` 才能记录宽度变更，所以 epoch handoff 在写回 options 之前调用 `sync_log_dir()`。

代价是多一次目录 fsync，以及崩溃后需要清理孤儿文件。孤儿文件只能通过显式的 `Sequences` 标记清理。

### WAL 的两个正交维度

每条 WAL 记录有两个归属维度：**逻辑组**决定事务事实、可见性、frontier 和 checkpoint age 的归属；**物理流**决定追加、恢复和 abort 链遍历使用的文件命名空间。逻辑组编码在记录里，不从物理流推断。

两种 `sync_on_write` 路由因此不是"同一套机制开不同的同步开关"，而是两种物理布局：

- **宽松路由**（`sync_on_write = false`）：每个逻辑组写自己的物理流。提交只把 WAL 字节刷到文件/页缓存就发布结果，没有 fsync generation，没有持久等待。崩溃可能丢失最近提交的事务。
- **持久路由**（`sync_on_write = true`）：所有逻辑组追加到同一个共享物理流，这个流有独立于 per-group 流的命名空间（`group_wal_` 前缀，shared id 是 255）。并发终结记录和显式 barrier 加入一个 caller-led 的 sync generation，这个 generation 封住一个 stream cut，同步所有贡献字节穿过该 cut 的 writer 以及 log 目录，然后完成所有目标被该 cut 覆盖的参与者。

拆分这两个维度带来的好处是：checkpoint age 在两种路由下都是 per logical group，只有物理流布局变了。切换 `sync_on_write` 因此是一次纯粹的物理布局迁移，事务语义、frontier、checkpoint 记账都不用改。代价是恢复必须扫描所有保留的物理流，不管这次打开请求的是哪个路由，这样才可能发现两个命名空间里的历史。

持久路由还有一个细节：WAL 缓冲轮转和普通 flush 不推进持久流位置，只有一个成功的 sync generation 才推进。

### abort-clean：重写而不是 undo

备选是给每个操作实现逆操作。

选重写的理由是版本历史已经让旧版本不可见，不需要额外的撤销通道；而且重写顺便回收了空间。修改过的事务中止时保留三样东西：中止结果、物理 WAL 流和链区间、受影响的 bucket 集合。

代价是 O(受影响页面) 的写放大，加上两阶段的生命周期：先 pending rewrite（重写页面、每个受影响 bucket 完成一次新 checkpoint、abort 结果和 WAL pin 一直保留），再 waiting for quiescence（重写的页已持久、可能持有旧页镜像的读者排空、然后移除任务和 pin）。整个过程中被中止的版本始终不可见。

### 恢复的三个独立边界

恢复用三个独立的 WAL 相关边界，加载和推进都各自独立：

- **bucket frontier**：某个更新是否已经持久在 bucket 数据里。这是 redo 的判定门，而且是唯一的门。
- **checkpoint hint**：WAL 分析可以从哪里开始。
- **recycle boundary**：哪些更老的 WAL 文件已经被删除。

备选是用单一的"检查点位置"，但那样恢复无法区分"这个更新已经在页里了"和"这个更新的 WAL 还在"。分开之后每个边界可以按自己的节奏推进。

代价是跨阶段的陈旧值风险。一个值可能在构造时被读取，然后后续阶段把它的持久来源推进了，于是它就过期了。我把这类问题单列成一条静态审查要求：每个不变式都要从当前状态重新推导，不能从它最初被设置的地方推导。

启动顺序在 `docs/design.md` 第 9 节有完整的 12 步，关键点是恢复必须在任何前台事务或 view 准入之前完成，并且必须把重建出来的 abort-clean 工作排空之后，运行时 checkpoint 记录和启动后 WAL 回收才成立。

## 开放问题与被放弃的方案

上面提到的三条 `suspect` 约束是公开的开放问题。除了它们，我还想记下几个被放弃的方案，避免以后有人重新提一遍。

**undo 式回滚**。最早的想法是给 put/del 都实现逆操作，中止时回放。放弃的原因是它和版本历史、blob payload 分离、页合并三条机制都有交互，每增加一种操作类型就要证明一遍。改成重写之后，中止的正确性论证只依赖"哪些页被重写了"，而不依赖操作的可逆性。

**group-local resolved prefix**。曾经有过一个约束，声称可见性有一个 group 局部的已解析前缀，因此存在一个可以跨越 active hole 的终结队列或前缀边界。这个约束在 2026-07-20 退休了，因为可见性不再有这个 group 局部的证明，前缀边界本身就没有意义了。现在是精确的 `TxnFact` 查表，active hole 的可见性由 live safe boundary 和精确结果两条约束覆盖。

**WAL 格式升级协议**。曾经有一个约束把 graceful exit 的 WAL 无关不变式误当成数据格式升级协议，2026-09-01 退休，因为当前的 data/blob 格式是 V1-only，根本没有格式升级协议。取而代之的是 `protocol.graceful_exit_wal_independent_visibility`。

WAL 格式的当前立场是单向演进：只有更新的二进制能打开写入了 merge-capable payload 的目录，所以新增的记录类型（比如 merge operand payload）不需要迁移屏障。代价是部署一个会写新 WAL payload 类型的二进制，就等于把这个目录提交给至少该能力等级的二进制，不支持降级。这条边界只适用于 record envelope 不变的加法式 payload 变更；改 Update envelope 本身仍然需要先达到一个 WAL 无关的持久状态。

## 不变式与验证

mace 用一个机器可读的台账 `docs/constraints/registry.yaml` 管理不变式，目前 64 条，其中 61 条 `active`、3 条 `suspect`。按类型分，54 条是 `protocol`（跨若干步骤或生命周期阶段）、5 条 `local`、3 条 `dependency`（依赖上游或外部契约语义）、2 条 `emergent`（靠多条路径共同维持）。

每条记录包含：statement、watch_points（什么改动应该触发重新 review）、witnesses（现在哪些代码路径在维护它）、failure_symptoms（坏了会看到什么）、verifiers（现在有什么验证）。可选字段有 confidence、invalidation_triggers、next_actions、notes。

为什么要这么重？因为 mace 的大部分不变式没有单一 owner 函数。写路径 + checkpoint + 读路径、manifest 发布 + 恢复 + GC、mace 逻辑 + btree-store 契约，这些约束跨模块，给它们指定一个 owner 会误导 review。

状态含义是有梯度的：`draft` 是观察到或推断出来的，还不够强；`active` 是现在依赖它并且有至少一个像样的 verifier；`suspect` 是很可能成立但必须重新 review，因为证据弱、陈旧，或者 watch point 变了。工作规则很硬——如果一次改动碰到了某条 `active` 约束的 watch point，必须在同一批改动里做三件事之一：重跑或更新列出的 verifier 并保持原状、降级成 `suspect`、或者如果这条约束已经不再有意图成立就移进 `docs/constraints/retired.md` 并记录原因。

验证手段分几层：

- **单元和集成测试**，`tests/` 下 30 个文件。按触及的边界选目标而不是每次全量跑：bucket/GC/abort-clean 跑 `tests/gc.rs`、`tests/prod_gc.rs`，恢复/checkpoint/WAL 回收跑 `tests/prod_recovery_failpoints.rs`，view 生命周期和可见性跑 `tests/cc.rs`，背压跑 `tests/backpressure.rs`。
- **failpoint 崩溃窗口测试**。`failpoints` feature 依赖 `extra_check`，`extra_check` 依赖 `metrics`。failpoint 测试需要 extra_check 的确定性同步点和指标见证，所以 `--features failpoints` 一个就够。failpoint 的"咨询"本身也要求可计数、可上报，这样测试才能证明它确实在预期的点上被触发过。
- **生产流脚本** `./scripts/prod_test.sh fast|stress|chaos|all`，覆盖真实的 bucket churn、evictor 压力、GC、workload 和恢复。
- **离线只读检查器** `check_database()`，报告每一处损坏且只报告一次，有独立的 CLI 契约。默认构建里可观测性代码是零：`metrics` feature 才编译 `Options.observer` 和所有 `observe::*` 调用。指标身份保持固定基数，不包含无界的 bucket、key 或事务标签。

默认测试矩阵是：clippy 全特性零警告；release + extra_check 连续三轮全绿且每轮 180 秒内；debug + extra_check 同样三轮；nightly AddressSanitizer 一轮；生产流一轮。任何非零退出、timeout、panic、sanitizer report 都算对应 gate 失败，修完必须从完整连续轮次重来，不能拼接失败前后的成功轮次。

---

这篇只讲形状和代价。具体的执行顺序在 `docs/design.md`，每一条不变式的见证代码和 verifier 在 `docs/constraints/registry.yaml`。如果你发现某个设计决策在文章里被写错了或者漏了一个代价，指出即可。
