---
title: btree-store 2.0
description: Release notes and migration guide — per-page checksums, the offline check / compact / migrate tools, and how to move a 1.x database to the 2.0 format
pubDatetime: 2026-10-01
tags:
  - btree-store-release
---

After about a month of work, [btree-store](https://crates.io/crates/btree-store) is at 2.0. There are two things this release is about: 1. stronger reliability, and 2. maintaining the database.

## Stronger reliability

Before 1.0 I removed most of btree-store's data validation and kept only the meta page check. The reasoning was simple: trust the filesystem and the hardware to checksum and correct, and skip the checks because they cost time. In 2.0 I put the validation back, and the reasoning is just as simple — not every filesystem can detect silent data corruption (zfs and btrfs do), and btree-store is mace's metadata store, where silent corruption is fatal.

The new validation covers `meta page`, `indirect page`, `extent page`, `overflow page` and `value page`, and it folds the `page id` into the checksum as well, which also closes the hole where two pages with identical contents get swapped and slip through unnoticed. The cost is that the storage format has to change, so 2.0 adds a `btree-store` command line tool whose `migrate` command converts a 1.x database into the 2.0 format.

## Maintaining the database

Besides `migrate`, 2.0 introduces `check` and `compact` (both offline). The former, `check`, audits a database file read-only and reports things like:
- whether the file is complete
- whether any `page id` reference forms a cycle
- whether space is being leaked
- per-bucket details
- ...

The latter, `compact`, squashes the file — dropping the free pages in the middle to make the database smaller. For now it can only write the compacted result to another file; the inplace mode is a placeholder I may implement later if it turns out to be needed.

Worth explaining why compaction is offline. Before 1.0 btree-store did support online compaction, and it worked like this: move the live pages at the tail of the database file into the free pages at the front. Since btree-store is copy-on-write, relocating a node must not disturb its parent, so that design inserted an indirection layer — the `page id` became a logical id, and relocating a page only meant updating the mapping. The cost was that inserts ran 50–60× slower than they do with physical ids. `compact` is a rare operation, and every insert should not be made to pay for it.

Besides the offline command line tools, 2.0 adds two maintenance-oriented APIs:

- `BTree::open_read_only()` opens a database read-only, for inspection
- `BTree::take_snapshot()` writes a snapshot of the current database, for backups

---

## Migration guide

The only genuine compatibility break in 2.0 is the storage format. 1.x wrote format version 1, while 2.0 reads and writes format version 2, so a database created by any 1.x release is refused outright by 2.0 — and it does not guess:

```text
OpenError::Corruption(CorruptionReport {
    code: "UNSUPPORTED_FORMAT_VERSION",
    expected: Some("2"),
    actual: Some("1"),
})
```

The old file is not damaged; the new code simply cannot read its format. Rebuilding it once, offline, with the 2.0 command line tool is all it takes.

### Rebuilding the database file

First get the 2.0 command line tool. The executable ships inside the `btree-store` crate, so there is no separate package to go looking for:

```bash
cargo install btree-store --version 2.0.0
```

Then **stop whatever program is using the database** — this step cannot be skipped. `migrate` takes a *shared* lock on the source, while a running read-write instance holds an *exclusive* lock, so leaving it running is refused with `lock-busy`. `migrate` also cannot see any writes made after it read the source, so migrating a database that is still being written rebuilds it from an inconsistent point in time.

```bash
btree-store migrate old.db --output new.db --to 2
```

In order, it opens the source read-only and confirms the format version; validates the source's metadata, catalog, every bucket tree, the value and indirect chains and the allocator's ownership **before creating any output at all**, so a bad reference is caught up front rather than when its page is read; rebuilds the database into a private staging file with the 2.0 writer; reopens the staging file with a brand-new 2.0 instance and compares it to the source bucket by bucket, key by key, value by value; and only then syncs the data, renames the staging file onto `--output`, and finally syncs the destination directory.

So the source is never modified, never truncated, never replaced, and is never itself the destination. The destination is replaced atomically only after verification has passed; if the run fails partway, the destination keeps its old contents and the staging file is removed.

One thing to know: the published file's permissions are the source's permissions `& 0600`, so at most the owner's read and write bits survive. A `0644` source migrates to a `0600` file. That came along with making the staging file private from the moment it is created, and it will cost you if the database is shared across a group.

### Verifying

```bash
btree-store check new.db --summary
```

A passing run exits `0` and its first line is `status=ok`. `check` is read-only throughout and never modifies the file. Once that looks right, point your program at `new.db` and keep `old.db` for now.

### Rolling back

The migration is non-destructive, so rolling back means swapping the file back: the source has been sitting there untouched the whole time. Note that whatever you roll back to has to run on the 1.x library, because 2.0 will not open the file.

There is exactly one error class to watch out for: `published-durability-unknown` means the rename succeeded but the destination directory sync afterwards failed, so the new file *is* in place and we simply cannot confirm it survives a power loss. No other failure touches the destination.

### Three Rust API incompatibilities

Besides the file format, there are three things to change in code:

| Change | What to do |
| --- | --- |
| `Txn::iter_uncached` and `ReadOnlyTxn::iter_uncached` are gone | call `iter()`; every iterator now goes through the shared node cache |
| `OpenOptions` gained a `read_only: bool` field | add it if you construct the struct with a literal; `OpenOptions::new()` and `Default` are unchanged and leave it `false` |
| `Error::ReadOnly` and `OpenError::ReadOnly` are new variants | neither enum is marked `#[non_exhaustive]`, so an exhaustive `match` stops compiling — add an arm |

The full version is in [docs/migration.md](https://github.com/abbycin/btree-store/blob/master/docs/migration.md), and every command argument and error class is in [docs/cli.md](https://github.com/abbycin/btree-store/blob/master/docs/cli.md).