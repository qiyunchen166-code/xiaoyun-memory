# Notes: WAL, backups and checkpoints, measured

Numbers from a ~5.4k-row SQLite database in WAL mode, `page_size=4096`, on Windows.

## Copying a live database

`sqlite3` keeps committed data in `<db>-wal` until a checkpoint writes it back. Copying only the `.sqlite3` file can silently lose the tail of the log.

Experiment: open a copy with `wal_autocheckpoint=0`, insert 100 rows (WAL grows to 12,392 bytes), then:

| copy | result |
| --- | --- |
| `db.sqlite3` only | opens, but `select` on the new table fails: `no such table` |
| `db.sqlite3` + `-wal` | 100 rows |
| `VACUUM INTO 'copy.sqlite3'` | 100 rows |

`VACUUM INTO` is the safe one-shot backup: it reads through the WAL and writes a compact database. For a 27 MB database it took 261–276 ms; `pragma integrity_check` 97–113 ms; two runs produced byte-identical files (same sha256).

If you do copy files, copy `-wal` and `-shm` too, or stop writers and checkpoint first.

## Checkpoints

WAL frames are appended; a checkpoint copies them back into the main file. Three modes:

| mode | time (2,000 rows, 200 B each) | frames | WAL after |
| --- | --- | --- | --- |
| `PASSIVE` | 9.6 ms | 110 | unchanged (453,232 B) |
| `FULL` | 8.8 ms | 108 | unchanged |
| `TRUNCATE` | 8.8 ms while a reader holds a snapshot → `busy=1` | — | unchanged |
| `TRUNCATE` after the reader commits | 0.2 ms | — | 0 |

So `PASSIVE`/`FULL` write pages back but never shrink the file; only `TRUNCATE`/`RESTART` reset it, and they fail (busy) while any reader still needs an old snapshot. Short queries finish and release; a long-running read transaction is what blocks it.

## Writing throughput

5,000 rows of 200 B, WAL mode:

| style | time | rows/s |
| --- | --- | --- |
| one autocommit per row | 296 ms | 16,905 |
| 100-row transactions | 15 ms | 333,000 |
| single transaction | 11 ms | 458,476 |
| same, `synchronous=OFF` | 155 ms | — |
| one autocommit per row, `journal_mode=delete` | 42,317 ms | 118 |

The last row is the point: with a rollback journal, every commit is journal-write + fsync + delete, and on this machine an fsync costs ~8 ms. Batch your writes.

## Frame layout, briefly

- WAL header: 32 bytes — magic `0x377f0682`/`0x377f0683`, format version, page size, checkpoint sequence, salt-1/2, checksums.
- Each frame: 24-byte header (page number, database size after commit, salt copies, checksum) + one page.
- Frame size = page size + 24. Checksums roll over the previous frame, so a truncated tail is detectable.
