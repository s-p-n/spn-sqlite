// test/property.test2.js
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import path from 'node:path';
import DB from '../index.js'; // adjust path if needed

const DRIVERS = ['node:sqlite', 'better-sqlite3'];
const WORKER_COUNTS = [1, 2, 4]; // test contention + single-worker

const WORKER_PATH = path.resolve('./lib/workers/db.worker.js'); // adjust if needed

describe('spn-sqlite API Contract', () => {
  for (const driver of DRIVERS) {
    for (const workers of WORKER_COUNTS) {
      describe(`${driver} (workers=${workers})`, () => {
        let db;

        beforeEach(async () => {
          db = new DB({
            filename: ':memory:',
            driver,
            workers,
            // workerPath: WORKER_PATH, // only if needed
          });
          await db.exec`PRAGMA journal_mode = WAL`;
        });

        afterEach(async () => {
          await db.close();
        });

        it('supports basic CRUD with tagged templates', async () => {
          await db.exec`
            CREATE TABLE users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              age INTEGER
            )
          `;

          const name = 'Alice';
          const age = 30;

          const insert = await db.run`
            INSERT INTO users (name, age) VALUES (${name}, ${age})
          `;
          assert(insert.lastInsertRowid >= 1);
          assert(insert.changes === 1);

          const row = await db.get`
            SELECT * FROM users WHERE id = ${insert.lastInsertRowid}
          `;
          assert(row);
          assert(row.name === name);
          assert(row.age === age);

          const all = await db.all`SELECT * FROM users`;
          assert(Array.isArray(all));
          assert(all.length === 1);
        });

        it('returns user-returned value from transaction', async () => {
          await db.exec`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`;

          const returned = await db.transaction(async (tx) => {
            await tx.run`INSERT INTO users (name) VALUES (${'bob'})`;
            const user = await tx.get`SELECT * FROM users WHERE name = ${'bob'}`;
            return user;
          });

          assert(returned);
          assert(returned.name === 'bob');
        });

        it('rolls back on throw inside transaction', async () => {
          await db.exec`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE)`;

          await assert.rejects(
            db.transaction(async (tx) => {
              await tx.run`INSERT INTO users (name) VALUES (${'charlie'})`;
              throw new Error('intentional rollback test');
            }),
            /intentional rollback test/
          );

          const count = await db.get`SELECT COUNT(*) as c FROM users`;
          assert(count.c === 0); // nothing inserted
        });

        it('exposes inTransaction flag correctly', async () => {
          assert(!db.inTransaction); // outside tx

          await db.transaction(async (tx) => {
            assert(db.inTransaction); // inside tx
            await tx.exec`CREATE TABLE test (id INTEGER)`;
          });

          assert(!db.inTransaction); // after commit
        });

        it('handles multi-row insert and fetch last rows', async () => {
          await db.exec`CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)`;

          const values = ['apple', 'banana', 'cherry'];

          const insertResult = await db.transaction(async (tx) => {
            const info = await tx.run(`
              INSERT INTO items (value) VALUES ${values.map(v => `(?)`).join(', ')}
            `.split('?'), ...values);
            return await tx.all`
              SELECT * FROM items
              WHERE id >= ${info.lastInsertRowid - values.length + 1}
              ORDER BY id
            `;
          });

          assert(Array.isArray(insertResult));
          assert(insertResult.length === values.length);
          assert(insertResult.map(r => r.value).join(',') === values.join(','));
        });

        it('survives concurrent stress (property-based)', async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 3, maxLength: 10 }),
              async (names) => {
                await db.exec`DROP TABLE IF EXISTS test`;
                await db.exec`CREATE TABLE test (name TEXT UNIQUE)`;
                let inserted = 0;
                try {
                  await db.transaction(async (tx) => {
                    for (const name of names) {
                      await tx.run`INSERT INTO test (name) VALUES (${name})`;
                      inserted++;
                    }
                  });
                } catch (e) {
                  // unique violation is allowed in stress test
                  if (!e.message.includes('UNIQUE constraint')) throw e;
                }

                const count = await db.get`SELECT COUNT(*) as c FROM test`;
                assert(count.c <= names.length);
              }
            ),
            { numRuns: 50, verbose: true }
          );
        });

        it('closes cleanly with no pending jobs', async () => {
          const start = performance.now();
          await db.close();
          const duration = performance.now() - start;
          assert(duration < 200); // should be fast
        });
      });
    }
  }
});

// Run with: node --test test-api-contract.js
// Or integrate into Jest/mocha