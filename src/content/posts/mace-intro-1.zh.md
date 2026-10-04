---
title: mace -- 背景
description: mace (mace-kv) 诞生的背景和早期探索及演化
pubDatetime: 2026-09-30
tags:
  - mace-internal
---

[mace](https://github.com/abbycin/mace)（mace-kv） 是我在 2024 年开始编写的一个 key-value 数据库。它的出现绕不开 [junkfs](https://github.com/abbycin/junkfs) 这个 FUSE 文件系统的练手项目。在我的设计中，文件系统的元数据使用 key-value 数据库来存储，这些元数据包括：`inode`、`dentry`、`superblock` 等。例如文件的表示就是 `i_$ino` 作为 key，而其 value 就是序列化后的结构体，其中包括权限、大小、名字等信息

一开始，这个文件系统还是用 C++ 写的，但考虑到依赖管理和测试的需要，不久就转向了 Rust。最早在 key-value 数据库选型时，考虑过 rocksdb，但由于它在 Rust 的绑定太重了，vim 打开都会卡死，并且我从来没有成功地把它编译出来，于是选择了名气较大的 sled 作为替代。但一段时间后我发现了 sled 的问题：1. 它非常占用空间。2. 它的事务很难用。3. 它其实很久都不更新了。

巧合的是，这期间我在知乎上看到了 leanstore 的论文解读，还看到了一个叫 photondb 的项目的介绍。于是我阅读了 photondb 和 leanstore 的代码，也看了一些数据库相关的 paper，这让我产生了自己写一个的想法，理由很简单：leanstore 和 photondb 的代码量不大。至于为什么没有使用它们来替换 sled，原因也很简单：leanstore 和 photondb 只能算是半成品，其中 leanstore 的恢复和回滚都没有完整的实现，photondb 干脆没有事务，并且 leanstore 自己搞了一套 JUMPMU 的东西用来做冲突回滚，这套机制多半没法移植到 Rust

为什么需要事务，当时的想法是：磁盘文件系统要么通过 COW，要么需要使用日志来确保原子性和崩溃安全，比如 `rename` 这种操作就必须是原子的。在用户态中既然选择了 key-value 数据库来管理元数据，那么它也应该是原子的、崩溃安全的，那么支持事务就是理所应当的

于是 mace 出现了，当时的定位也很清晰：一个支持事务的、append-only 的 key-value 存储引擎。为什么是 append-only，这里可以解释一下，当时有两点考虑：1. 文件的创建和删除也要快。2. 想了解一下垃圾回收是怎么工作的（这是一点私心），append-only 才需要垃圾回收。最初 mace 的实现几乎就是 leanstore 和 photondb 的杂合版，其中参考了 leanstore 的事务机制、photondb 的索引实现以及 buffer 管理

但随着研究的深入，逐渐发现 leanstore 和 photondb 各自存在的问题，比如：leanstore 使用的是 per-worker 事务处理 + Group Commit，也就是说，你一开始就需要固定好 worker 的数据，把 worker 和 CPU 核绑定，好处是事务都是并行的，缺点是没办法扩展，并且测试发现 Group Commit 的完成通知就是写事务的瓶颈。而 photondb 也有问题，对于不断更新的 key 来说，在对 node 做 consolidation 时需要保证这些 key 在同一个 node 上，否则 Bw-Tree 的查找路由就会出错。如果一个 key 频繁地更新，会导致一个 node 的大小失控

于是，mace 开始寻求改变。在此期间我阅读了 sled、surrealkv、postgresql、boltdb、leveldb 的相关实现，也读了一些 paper 和书籍（Database internals 和 Database System Concepts），在 junkfs 的需求驱动下，最终有了现在 mace 的形态

![mace-arch](/images/mace-arch.jpg)
