---
title: btree-store 2.0
description: 发布记录和迁移指南 —— per-page 校验和、离线 check / compact / migrate 工具，以及如何把 1.x 的库文件迁移到 2.0 格式
pubDatetime: 2026-10-01
tags:
  - btree-store-release
---

经过差不多一个月的开发，[btree-store](https://crates.io/crates/btree-store) 现在已经是 2.0 版本了，2.0 版本主要的关注点是：1. 可靠性增强， 2. 数据库的维护

## 可靠性增强
在 1.0 之前，我删除了 btree-store 的大部分数据校验，只保留了 meta page 的校验，当时的理由很简单：相信文件系统和硬件的校验和纠错，并且去掉校验会更快。这次 2.0 中，我又把数据校验加了回来，理由也很简单：对于静默数据错误，并不是所有文件系统都能检查（zfs、btrfs 还行），而 btree-store 正是 mace 的元数据存储，静默数据错误是致命的

本次增加的数据校验对 `meta page`、`indirect page`、`extent page`、`overflow page`、`value page` 等都做了覆盖，并且将 `page id` 也纳入校验范围，这也避免了内容相同但被调换的两个 page 被静默绕过。但代价是存储格式必须更改，因此 2.0 版本增加了 `btree-store` 命令行工具，通过 `migrate` 选项可以将 1.0 版本的格式转换成 2.0 版本

## 数据库维护

除了前面提到的 `migrate`，2.0 中还引入了 `check`、`compact` 选项（这些都是离线的）。前者 `check` 对数据库文件做只读检查，用来发现这些问题：

- 是否是完整的
- 是否存在 `page id` 的循环引用
- 是否存在空间泄漏
- 打印出 bucket 的详情
- ...

后者 `compact` 是对数据库文件做压实（去掉中间空闲的 page，从而减小数据库文件的体积），目前仅支持将压实后的数据写到另一个文件，inplace 压缩目前只是一个占位，后续有需要时再实现

这里要说明一下，做离线压缩是权衡后的结果。在 1.0 之前，btree-store 曾经支持在线压缩，它的原理是：将数据库文件尾部活跃的 page 的数据搬迁到前面的空闲 page 中。由于 btree-store 是 COW 的实现，为了避免搬迁节点影响父节点，引入了一个间接层，`page id` 是逻辑 id，搬迁 page 只需要修改逻辑 id 的映射即可，但代价是插入性能比直接使用物理 id 慢了 50～60 倍。而 `compact` 是低频操作，不应该让每次插入都为此付费

除了离线的命令行工具，2.0 还增加了两个维护相关的 API

- `BTree::open_read_only()` 以只读模式打开，用于检查
- `BTree::take_snapshot()` 对当前的数据库打快照，用于备份

---

## 迁移指南

2.0 唯一真正破坏兼容的地方是存储格式。1.x 写的是 format version 1，而 2.0 只读写 format version 2，所以 1.x 创建出来的库文件在 2.0 里会被直接拒绝，并且它不会去猜：

```text
OpenError::Corruption(CorruptionReport {
    code: "UNSUPPORTED_FORMAT_VERSION",
    expected: Some("2"),
    actual: Some("1"),
})
```

旧文件本身没有坏，只是新代码读不懂它的格式，用 2.0 的命令行工具离线重建一次就行。

### 重建库文件

先装 2.0 的命令行工具。可执行文件是跟着 `btree-store` 这个 crate 一起发布的，不用另外找一个包：

```bash
cargo install btree-store --version 2.0.0
```

然后**先把正在用这个库的程序停掉**，这一步不能省。`migrate` 对源文件加的是共享锁，而一个正在运行的读写实例持有的是排他锁，不停掉就会直接报 `lock-busy`。而且 `migrate` 看不到源文件读完之后的新写入，边写边迁等于从一个不一致的时间点重建。

```bash
btree-store migrate old.db --output new.db --to 2
```

它按顺序做这些事：只读打开源文件并确认格式版本；在创建任何输出之前，把源文件的元数据、catalog、每个 bucket 的树、value 与 indirect 链，以及 allocator 的归属完整校验一遍；在私有的 staging 文件里用 2.0 的写入器重建；用一个全新的 2.0 实例重新打开 staging 文件，逐 bucket、逐 key、逐 value 与源文件比对；比对通过之后 sync 数据，把 staging 文件 rename 到 `--output` 上；最后 sync 目标目录。

所以源文件在整个过程中不会被修改，不会被截断，也不会被替换，并且它自己永远不会被当成目标文件。目标文件只有在验证通过之后才会被原子替换，中途失败时目标文件的名字保持不变，staging 文件也会被清掉。

有一处需要注意：发布出来的文件权限是源文件权限 `& 0600` 之后的值，最多只保留属主的读写权限，一个 `0644` 的源文件迁出来会是 `0600`。这是当初为了让 staging 文件从创建那一刻起就是私有的而顺手带上的行为，在 group 共享的场景下会让人吃一次亏。

### 验证

```bash
btree-store check new.db --summary
```

通过时退出码是 `0`，第一行是 `status=ok`。`check` 全程只读，不会改动文件。确认没问题之后，把程序的路径指到 `new.db`，`old.db` 先留着别删。

### 回滚

迁移是非破坏性的，回滚就是把文件换回去，源文件一直原封不动地躺在那里。要注意的是换回去得用 1.x 的库来跑，因为 2.0 打不开它。

错误类里只有一个例外需要留意：`published-durability-unknown` 表示 rename 已经成功了，只是之后 sync 目标目录失败，新文件已经在位置上，只是掉电后是否还在不能确认。除它之外的任何失败都不会改动目标文件。

### Rust API 的三处不兼容

文件格式之外，代码也需要改三处：

| 变更 | 怎么改 |
| --- | --- |
| `Txn::iter_uncached`、`ReadOnlyTxn::iter_uncached` 已删除 | 改用 `iter()`，现在所有迭代器都走共享的 node cache |
| `OpenOptions` 增加了 `read_only: bool` | 用结构体字面量构造的话要补上这个字段；`OpenOptions::new()` 和 `Default` 不变，默认为 `false` |
| 新增 `Error::ReadOnly` 和 `OpenError::ReadOnly` | 两个枚举都没有标注 `#[non_exhaustive]`，穷尽的 `match` 会编译不过，加一个分支即可 |

完整版见 [docs/migration.md](https://github.com/abbycin/btree-store/blob/master/docs/migration.md)，命令的完整参数与全部错误类见 [docs/cli.md](https://github.com/abbycin/btree-store/blob/master/docs/cli.md)。
