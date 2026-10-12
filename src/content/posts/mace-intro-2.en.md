---
title: mace -- Architecture Design
description: The architecture of mace (mace-kv) and the key design decisions behind it
pubDatetime: 2026-10-01
unlisted: false
tags:
  - mace-internal
---

The question this post answers is: why is mace shaped the way it is, and what does each part of that shape cost.

- To find out what mace does and how fast it is, see the [README](https://github.com/abbycin/mace)
- To change mace's code, read `docs/design.md` (the protocol reference) and `docs/constraints/registry.yaml` (the invariant ledger)
- To judge whether a change should be made at all, read this post

## Design Goals and Priorities

Start with what mace does not aim for, because what a system does not pursue constrains the design more than what it does.

mace is an embedded engine. It is single-process, not distributed, not SQL, no multi-tenant isolation, and no cross-node replication or consensus. None of this is scheduled for later; all of it is ruled out explicitly, because the moment node-to-node communication enters the picture, every reasoning step about crash windows has to be redone.

Among the goals that remain, the priorities are:

1. **Crash safety and no data loss.** This is the only one that cannot be compromised. If a performance optimization requires loosening the durability boundary, it is rejected outright.
2. **Snapshot-isolation semantics.** A committed transaction must still be visible after a crash; an aborted one must still be invisible.
3. **Throughput and latency.** Optimized only where 1 and 2 are still intact.
4. **Implementation simplicity.** This one ranks last, but it is still a real constraint: mace's effective code is around 20K lines, which is no longer "simple", and simplifying it remains long-term work

The guarantees in items 1 and 2 have one precondition: the durability option must stay at its default. When it is on, every commit requires the WAL to actually reach the disk, so a committed transaction survives a crash. Another sign of the same rule is graceful exit: even when the whole run used the relaxed mode, the final checkpoint still fully syncs every output file. During normal runs the boundary can be relaxed; at exit it cannot, because once the process is gone there is no WAL left to fall back on.

## Where the Real Difficulty Lies

Not the index, not the transaction layer, but the **handoff of state between phases**.

### A checkpoint collects the reachable set, not the dirty set

This is the trade-off I most want to explain about mace, because it decides what a checkpoint actually is.

The intuitive approach is to have the checkpoint collect all the dirty pages and write them out. That works in a model where pages are immutable and writers do not change page reachability, such as an LSM-tree memtable. Bw-Tree does not. A page that has gone dirty may already be unreachable by the time the checkpoint reaches it: its delta chain was consolidated, its parent's link was swapped to a new page, or a node split or merge produced a new page image. Writing those pages anyway produces pure garbage — write amplification paid for nothing — and the next GC pass will treat them as space to reclaim.

So mace's checkpoint collects the **set of pages reachable from the dirty roots**, not the set of dirty pages. Call that set the **write set**; it is the batch of pages this checkpoint writes into the data and blob files.

> Then why not an arena? Logical addresses are allocated monotonically, so treating the dirty region as one contiguous block of memory and flushing it wholesale would avoid the traversal entirely.
>
> The reason this cannot be done is Bw-Tree itself: **pages are replaced whole**. One consolidation produces a new base page and retires the old one entirely; one split turns a node into two and the original page is retired along with it. So at any moment, a reserved contiguous region has a substantial share of its slots holding dead pages that have already been superseded.
>
> In other words, **an arena has very low effective payload**. The reserved space has to be sized for the peak, and a large part of that peak is garbage. mace does the opposite: each page is allocated and released independently, and once a page becomes unreachable its memory goes straight back, so memory usage follows **live data** instead of some reserved region.
>
> The cost is that the address space is no longer contiguous, so the question "which pages are still alive" cannot be answered by scanning a range. It can only be answered by a reachability traversal.

#### The traversal must also produce two accounting values

The first is the **durable frontier**. During recovery, one WAL record at a time has to be tested for whether it needs replay: if the update it carries has already landed in a durable page, skip it. The frontier is what answers that question. It is recorded per bucket, one position per writer group, and its definition is:

> For each bucket, the maximum update position covered by all pages in that bucket's write set, taken per writer group.

It has a direction, and the direction is what forces the definition:

- Reported **too high**, recovery skips updates that are not actually durable yet → **data loss**
- Reported **too low**, recovery replays updates that are already durable → wasted work, but no data loss

The cost is not symmetric, so it would rather report low than high. And it can only be computed from the write set: if it is computed from the dirty pages, the updates belonging to dead pages that never entered the write set get counted in too, so it reports high and loses data.

The second value is garbage accounting. Each base page in the write set carries the old addresses it superseded, and those addresses can be retired from the ledger; which ones can be retired and which have to stay (ones produced during this checkpoint, or ones newer than the largest address allocated at the cut) can only be read out of the write set.

These two values, plus "which pages to write" and "which pages to drop from the page table", make four in total, and they all depend on each other.

To sum up this section's cost in one sentence: the reachability traversal lets mace write far fewer garbage pages, and pays for that with a checkpoint more expensive than enumerating dirty pages, while the correctness of both the frontier and the garbage accounting depends entirely on the traversal not missing anything.

### GC and checkpoint modify the same accounting at the same time

The partial rewrite of garbage collection selects victim files, reads their inactive records, builds replacement files, publishes the replacement accounting, then deletes the old files. At the same time, checkpoints are producing new garbage addresses, and they also need to update the inactive bitmap and the file statistics.

The difficulty is "ownership": for the logical addresses newly retired by a checkpoint while a rewrite is in progress, should they be recorded on the old file's books or the new file's books?

The usual fix is a handoff mutex, where one side may proceed only after the other has finished handing over. But that lock would span the whole rewrite, and a rewrite can run for a long time, during which every checkpoint is blocked: the writers' dirty data piles up without bound, which in turn raises rewrite pressure.

mace's choice is not to lock, but to judge by "who holds the ownership registration": the rewrite registers its ownership of those files before reading their inactive state, and when a checkpoint encounters a file already registered, it takes a branch different from the normal path: re-resolve the logical address, update the old file's books, and queue the address for the rewriting side to take; once the rewrite finishes, addresses that were already copied move over to the new file's books. The ownership state is released only after both the durable metadata and the runtime accounting point at the new files.

The cost is that the correctness of this handoff is no longer guaranteed by a lock, but by the ordering "registration before read" — get the order wrong and you get a space leak or negative statistics, and it takes a long time before the symptom shows (mace does have a leak fallback planned, shipping in a later version).

### Abort-clean is a rewrite, not an undo

An aborted transaction cannot be undone by reverse operations; mace physically removes the affected versions by rewriting pages. This brings two extra constraints: after the rewrite completes, readers that might still hold old page images must drain before the task can truly finish (the WAL retention stays pinned until then); and an already-unloaded bucket is not reloaded just for steady-state cleanup, so its task stays pending and blocks unload and delete. The full trade-off is in the decision section below.

## Concepts and the Identity Model

mace has four layers of identity, and this layering is the key to understanding the whole system.

| Identity | Meaning |
| --- | --- |
| bucket ID | durable identity of a named bucket |
| page ID | logical identity of an index page inside a bucket |
| logical address | durable identity of a persisted record inside a bucket's address space |
| file ID | identity of a data, blob, or WAL file |

Resolving a persisted page takes three steps: the bucket's page table maps the page ID to a logical address, the bucket's interval map maps that logical address to a data or blob file, and the file's relocation table maps the logical address to a byte range.

Why add this layer of indirection? Because garbage-collection rewrites change physical placement but keep logical addresses unchanged. The cost is that every persist has to maintain three tables — the interval map, the relocation table, and per-file statistics — and what it buys is that page references and version-history references stay completely stable across a file rewrite, which is what lets a rewrite run in the background without stopping writes.

Persisted state falls into four domains: metadata (everything but the WAL), WAL files (transaction redo records and checkpoint hints), data files (index pages and structural records), and blob files (large values). Metadata is what the database is rebuilt from; data and blob files become part of the database only through a metadata publish.

The runtime falls into three domains: foreground transactions and read-only views; the bucket runtime (index, cache, dirty generations, checkpoint state); and background services (checkpoint completion, recovery, abort-clean, WAL recycling, payload reclamation, bucket cleanup). Bucket runtimes are loaded lazily; opening a database does not pull in the index of every bucket.

## What We Borrowed, and Where We Deviated

mace's index structure comes from Bw-Tree: immutable page images plus delta-chain updates, where a tree mutation publishes a new page image instead of modifying the durable page in place. A delta chain is consolidated once its length reaches a threshold; the threshold is a per-bucket option, defaulting to half the node's maximum element count.

The following are deliberate deviations from the usual approach:

- **Bw-Tree's delta chain is not a linked list in memory.** In memory, a COW B+ tree holds the deltas, which gives two things:
  1. Query performance holds up
  2. For scans, nodes can be cached; for point lookups, the lock scope narrows
- **Data insertion is not lock-free.** In the original Bw-Tree an insertion is a CAS on the delta chain, but under high concurrency CAS brings:
  1. Cache-line ping-pong
  2. A large number of failures, so the allocation and copying it does are pure waste
- **Abort-clean uses rewrite instead of undo.** Undo needs an inverse implemented for each operation type, so every update writes two WAL records; mace trades a slightly more complex implementation for lower write amplification.
- **The Merge Operator is a purely runtime object and is never persisted.** The engine holds only a runtime handle and never records the operator's identity, so semantic compatibility across process restarts is the caller's responsibility. This avoids introducing the question "how do you express a user-defined type" into the disk format. (What is not persisted is the operator itself; merge operands are data written into the WAL and into pages.)
- **When the durability option is off, writes into the system page cache still count as valid.** This is the option's semantic contract, not sloppiness. Turning it off hands the guarantees in items 1 and 2 above to the caller; it is on by default, so default behavior is unaffected.

## Key Design Decisions

This section is the core of the post. For each decision I give: the alternative, the final choice, the reasoning, and the cost. "Data first" is a principle rather than a decision; I never had an alternative for it, so it carries only reasoning and cost.

### Index: why a Bw-Tree-style delta chain

The alternatives were an LSM tree (the RocksDB path) and a traditional B+Tree with in-place updates.

The reasoning is simple: mace wants both the query performance of a B+ tree and the write performance of an LSM tree. Bw-Tree pages are not fixed-size and are delta + base in form, which reduces write amplification; it can run compaction in the foreground, background garbage collection needs no per-key merge and only rewrites live data; and the data is one layer, so a query does not have to cross the multiple levels an LSM tree requires.

The cost: for cold data, a point lookup first has to read the whole delta chain out from disk. When persisted, the deltas are a linked list linked through the page header's `link` field, so reading a node means following `link` one page at a time, and the longer the chain the more reads. That is also why a consolidation threshold is necessary — merge the chain when it gets too long. Another trap I hit early on with photondb: if consolidation does not guarantee that all versions of a key land on the same node, the lookup routing breaks, and a frequently updated key lets one node's size grow out of control. mace's fix is to put version history into a key-local history region, with a descriptor recording which page and slot it starts at and how many versions it holds; different keys may share a history page, but each key is traversed only within its own declared range.

For that cost, mace has two compaction timings: on the read path, once the delta length reaches the threshold it compacts; at cache eviction, any leaf page still carrying deltas is compacted into a base page before it is swapped out. Compaction collapses the whole chain into one base: hot data is already in memory, and cold data, once compacted, needs only one IO to load again.

### Identity and location, kept separate

The alternative was a page ID mapped directly to a file and an offset.

The reasoning for the four-layer identity is that GC rewrites must proceed without stopping writes. If page references were bound to physical placement, a rewrite would have to update every page that references them, and readers would see a torn view. After the separation, a rewrite only edits the interval map and the relocation table.

The cost is two extra resolution steps, and every page read has to walk the whole chain. More importantly it becomes a discipline that must be held at all times: every reference uses a logical address, and a file ID is never used as a reference. That is not a style preference; it is the sole correctness precondition for this design. It has another benefit: IDs can use the full 64 bits, which both raises the data-management ceiling and removes any worry about wraparound.

### bucket as an autonomous unit

The alternative was one global index with buckets distinguished by key prefix.

The reasoning for bucket autonomy is that each bucket gets its own page address space, index state, checkpoint generation, durable frontier, cache policy, compression policy, and write-admission policy. This matters a lot for mixed workloads: a bucket holding large values and one holding small values should not share the same inline threshold.

The cost is that global services still have to coordinate transaction timestamps, WAL streams, recovery, and background maintenance. And "unload" must be strictly a runtime operation and must never weaken recovery or abort-clean semantics — durable metadata and payload files are entirely unchanged during an unload. Bucket deletion is also two-phase: logical delete first, physical cleanup later, and the bucket count decrements only after physical cleanup completes, so at any instant a crash leaves the books and the disk in agreement.

### Two dirty generations and one atomic cut

The alternatives were a single dirty set plus a checkpoint lock, or a copy-on-write snapshot.

The reasoning for the two-generation structure is that writers do not have to stop during a checkpoint. One cut rotates every checkpoint input at once, after which new writers use the new generation and the checkpoint holds the old one until publication completes.

The cost is that peak memory doubles (both generations present at once), plus the cost of reasoning about the cut boundary. Pages allocated after the cut stay in the new generation or are carried into the next checkpoint, and structural links, retired lineage, and garbage produced by compaction remain attached to whichever generation still owns their reachability.

The "peak memory doubles" above is only theoretical and cannot actually happen, because the background continuously drains the old generation while the foreground has flow control.

### Data first, metadata last

This is mace's only non-negotiable persistence ordering. For each output file the flow is:

1. Persist an orphan marker
2. Build the file
3. Sync the file and any required directory state
4. Commit intervals, relocations, statistics, the page table, and the durable frontier in one metadata transaction, and clear the orphan marker
5. Publish the new runtime interval and accounting state

Before the metadata commits, the output file is an orphan and is unreachable through durable metadata. After the metadata commits, it is the authoritative owner of the logical addresses it published.

The counterexample is direct: if the metadata pointed at a payload file that had not yet reached disk, and then a crash happened, the reopened metadata would point at a hole, reads would fail or return garbage, while the system believed the data was durable. The same rule holds in an epoch migration — the new era's files must first have durable directory entries before a width change can be recorded.

The cost is one more directory sync, plus orphan files to clean up after a crash. An orphan file is itself a durable marker; cleanup can only be driven by those markers and never by guessing through directory scans.

### Abort-clean: rewrite instead of undo

The alternative is implementing an inverse for every operation.

The reasoning for choosing rewrite is cost. Undo needs an inverse for every operation type, which means every update writes two WAL records; mace trades a slightly more complex page rewrite for lower write amplification. The rewrite also reclaims space for free — it was going to rewrite the pages anyway, and removing the aborted versions from the newly written copy adds no extra work.

As for "making aborted versions invisible", that is what abort-clean has to do, not the reason to choose it: version history already keeps aborted versions out of query results; the rewrite is there to actually get those bytes back. A modified transaction that aborts only needs three things retained: the fact that it aborted, the stretch of WAL it occupied, and which buckets it touched.

The cost is O(number of affected pages) of write amplification, plus a two-phase wind-down. First the pages are rewritten and every affected bucket completes a full checkpoint, with the abort fact and the WAL retention still pinned; only once the rewritten pages are truly durable and the readers that might hold old page images have drained can the task and its retention be withdrawn. Throughout, the aborted versions stay invisible — invisibility does not depend on the cleanup being finished.

### Recovery: three independent boundaries

Recovery uses three independent WAL-related boundaries, each loaded and advanced on its own:

- **bucket durable frontier**: whether an update is already durable in the bucket's data. This is the redo gate, and the only one.
- **checkpoint hint**: where WAL analysis may start.
- **recycle boundary**: which older WAL files have already been deleted.

The alternative was a single "checkpoint position", but then recovery cannot distinguish "this update is already in a page" from "this update's WAL is still here". Once separated, each boundary can advance at its own pace.

The cost is the stale-value risk across phases. A value may be read at construction, and then a later phase advances its durable source, so it goes stale. I make this a separate static-review requirement: every invariant must be re-derived from current state, never from where it was first set.

The full startup ordering is in the design document; the two key points are that recovery must complete before any foreground transaction or read-only view admission, and that the abort-clean work reconstructed from the WAL must be fully drained before runtime checkpoint recording and post-start WAL recycling become valid.

## Open Questions and Abandoned Approaches

Beyond the trade-offs above, I also want to record a few abandoned approaches, so nobody proposes them again later.

**Undo-based rollback.** The earliest idea was to implement an inverse for both writes and deletes, and replay it on abort. The reason it was dropped is WAL write amplification. On top of that, the WAL is written while a leaf node holds its lock (even though it is copied into a buffer), so writing more data means holding the lock longer.

**A group-local resolved prefix.** It was once proposed that visibility has a group-local resolved prefix, so there could be a terminal queue or prefix boundary that crosses a "pending hole". It was later dropped because visibility does not depend on such a group-local prefix proof, so the prefix boundary itself has no meaning. The current approach is an exact per-transaction table lookup, and the visibility of a pending hole is covered by the safe watermark and the exact-outcome rules.

**A WAL format upgrade protocol.** There was once a rule that misread the "no dependence on WAL after graceful exit" invariant as a data-format upgrade protocol; it was later deleted, because the current payload file has only one version and there simply is no format upgrade.

The current stance on WAL format is one-way evolution: newly added record types (such as the merge operand payload) need no migration barrier, because only newer binaries will open a directory that has new payloads written into it. The cost is that the directory can from then on only be opened by binaries of at least that capability level, and there is no downgrade path. This boundary applies only to additive changes under an unchanged record envelope; changing the record envelope itself still requires first reaching a WAL-independent durable state.

## How the Invariants Are Held

Every trade-off above corresponds to a rule that must hold, and almost every one spans multiple modules — the write path, checkpoint, and read path together form one, and metadata publish, recovery, and GC form another. Rules like these cannot be given an owning function; assigning one would mislead a review.

So mace puts them in a separate machine-readable ledger, and this ledger's first design decision is: **use the five consequences as the admission standard**.

### The admission standard: five consequences

For a rule to enter the ledger, it must be able to name which consequence breaking it produces:

- **Data loss**: data the database already acknowledged as committed is gone
- **Crash safety**: a reopen after a crash yields an inconsistent database, or one that will not open at all
- **Space leak**: bytes no longer reachable are never reclaimed
- **Visibility**: the reader sees something it should not, or loses something it should see
- **Concurrency**: data races, deadlock, livelock

If you cannot name one, it does not go in. API shape, tool behavior, memory budgets, test signals, and code style all go to the design document or a code comment.

This standard is more constraining than it looks: it forces every rule down to what an operator can actually observe. "This invariant is elegant" is not a reason; "breaking it makes one read return a key that was deleted" is. The ledger now holds 31 rules, grouped by what each one protects: visibility 10, data loss 8, space leak 8, crash safety 4, concurrency 1.

### What an entry looks like

One rule = **one enforcement boundary, plus the rules that share that boundary**. When several rules are in fact guaranteed by the same cut, the same transaction, or the same publication window, they merge into one entry — split them apart and the same counterexample gets written twice, and the reader has to notice on their own that they are the same thing.

Each rule records four things: the rule itself (written tightly enough to check against the code), the consequence of breaking it (written in the consequence's own terms, as "what you would see when it breaks"), the anchors (one to three repo-relative file paths), and the reproducer (one test name, or `none`).

Two details are deliberate. Anchors carry paths only and no line numbers, otherwise every edit would change the ledger and the ledger's updates would turn into noise. The reproducer may be `none`: an untested invariant is honest; a test that verifies nothing is not.

Earlier versions of the ledger also recorded observation points, witnessing code, verifiers, rule categories, confidence, and failure symptoms. They were removed for a concrete reason: they turned the ledger into a test index plus a list of code coordinates, rewritten on every refactor, with the result that the invariants themselves got buried under their own bookkeeping. The last restructuring cut more than half the entries this way — some folded into survivors that state the same thing, some moved out to the design document, the module docs, or code comments, and not a single rule was silently dropped.

### When to touch the ledger

Only in three cases: an invariant changed, an anchor actually moved, or an entry was retired.

**The code change itself is not a reason.** A refactor can rewrite many files without touching the ledger, as long as it has not changed any invariant. Conversely, a change that disturbs the boundary a rule depends on must either downgrade that rule in the same patch, or declare explicitly that it no longer holds.

A rule earns its confirmed status by being relied on, not by being well written. To retire one is to move it into the retirement record with the reason, not to delete it; folding one rule into another also counts as a retirement, with the survivor and the reason recorded — this way the ledger can shrink without losing the reasoning.

### Verifying an entry without a test

Read the rule itself, then apply the counterexample in its consequence to the current code: if the code still makes that state unreachable, the entry stands; if it no longer does, then either the code regressed and must be fixed, or the rule is no longer the one we want, and the entry must be rewritten or retired.

This also explains why the consequence is written as "what the operator sees" rather than "what is technically wrong" — it is meant to be used as a counterexample.

### Outside the ledger

The ledger covers invariants only. Regular tests are chosen by the boundary they touch rather than sweeping everything; crash windows use fault injection, deliberately crashing at deterministic sync points in the recovery flow and verifying consistency after restart — this is the most critical layer, because bugs in persistence ordering only manifest at a crash. Those verification mechanisms, together with their signals (a completed reclamation round must be observable, a failpoint hit must be countable), stay in their own code and tests, out of the ledger: they are tooling contracts, not invariants.

There is also a read-only offline checker that scans a database directory without starting the engine and reports each piece of damage exactly once. It reads the same metadata as the online path, but through fallible decoding paths — the online path, upon meeting a record it cannot decode, terminates the process outright, because at that point there is no reliable way to continue.

---

This post covers only shape and cost. The concrete execution ordering is in `docs/design.md`, and each invariant's anchors and reproducer are in `docs/constraints/registry.yaml`.
