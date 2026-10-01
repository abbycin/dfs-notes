---
title: mace -- background
description: Why mace (mace-kv) came to exist, and the early exploration and evolution behind it
pubDatetime: 2026-09-30
tags:
  - mace-internal
---

mace is a key-value database I started writing in 2024. It could not have appeared out of nowhere: it grew out of [junkfs](https://github.com/abbycin/junkfs), my practice project for a FUSE filesystem. In my design the filesystem's metadata is stored in a key-value database, and that metadata includes `inode`, `dentry`, `superblock` and so on. A file, for example, is represented by using `i_$ino` as the key, while its value is the serialized struct, holding the permissions, size, name and other fields.

At first the filesystem was written in C++, but dependency management and testing pushed me to Rust fairly quickly. When I first picked a key-value database, I considered rocksdb, but its Rust bindings are too heavy — just opening vim would hang — and I never actually managed to compile it, so I settled on the more famous sled instead. After a while, though, I found sled's problems: 1. it takes up a lot of space. 2. its transactions are hard to use. 3. it really hasn't been updated for a long time.

Coincidentally, that was also the period when I read a write-up of the leanstore paper on Zhihu and came across a project called photondb. So I read the code of photondb and leanstore, plus a few database-related papers, and that gave me the idea of writing one myself, for a very simple reason: leanstore and photondb are not that much code. The reason I did not simply use them to replace sled is just as simple: leanstore and photondb can only be called half-finished. leanstore has no complete implementation of recovery or rollback, photondb has no transactions at all, and leanstore even invented its own JUMPMU thing for conflict rollback, a mechanism that most likely cannot be ported to Rust.

Why does it need transactions? The thinking at the time was this: an on-disk filesystem ensures atomicity and crash safety either through COW or through a log — an operation like `rename` has to be atomic. Since, in user space, we chose a key-value database to manage the metadata, that database should be atomic and crash-safe too, so supporting transactions follows naturally.

So mace appeared, with a clear position from the start: a transactional, append-only key-value storage engine. Why append-only is worth explaining, because at the time I had two reasons: 1. file creation and deletion have to be fast too. 2. I wanted to understand how garbage collection works (that part is a little selfish) — only append-only needs garbage collection. The earliest implementation of mace was pretty much a hybrid of leanstore and photondb, taking leanstore's transaction mechanism, photondb's index implementation, and its buffer management.

But as I went deeper into the research, I gradually ran into the problems each of leanstore and photondb has. For example, leanstore uses per-worker transaction processing + Group Commit, which means you have to fix the worker's data up front and bind each worker to a CPU core. The upside is that transactions run in parallel; the downside is that it does not scale, and my tests showed that the completion notification of Group Commit is the real bottleneck for write transactions. photondb has problems of its own: for a key that is updated over and over, node consolidation has to guarantee that those keys stay on the same node, otherwise the Bw-Tree lookup routing breaks — and a key that is updated frequently will make the size of a single node run out of control.

So mace started looking for a change of direction. Along the way I read the relevant implementations in sled, surrealkv, postgresql, boltdb and leveldb, along with some papers and books (Database internals and Database System Concepts), and driven by what junkfs needed, mace eventually took the shape it has today.