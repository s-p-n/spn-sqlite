// test/property.test1.js
import { assert, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import DB from '../index.js';

const DRIVERS = ['node:sqlite', 'better-sqlite3'];
const WORKERS = [1, 2, 4]; // test with different counts

describe('spn-sqlite Property Tests', () => {
  // Helper to create DB with random options
  const createDB = (driver = fc.constantFrom(...DRIVERS)()) =>
    new DB({
      filename: ':memory:',
      driver,
      workers: fc.constantFrom(...WORKERS)()
    });

  it('should execute basic CRUD operations correctly for all drivers', async () => {
    await fc.asyncProperty(
      fc.constantFrom(...DRIVERS),
      fc.constantFrom(...WORKERS),
      async (driver, workers) => {
        const db = new DB({ filename: ':memory:', driver, workers });

        await db.exec`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`;

        const name = fc.stringOf(fc.hexa(), { minLength: 1, maxLength: 10 })();
        const insertResult = await db.run`INSERT INTO test (name) VALUES (${name})`;
        assert.ok(insertResult.changes === 1);
        assert.ok(insertResult.lastInsertRowid > 0);

        const row = await db.get`SELECT * FROM test WHERE id = ${insertResult.lastInsertRowid}`;
        assert.deepEqual(row.name, name);

        const all = await db.all`SELECT * FROM test`;
        assert.deepEqual(all.length, 1);

        await db.close();
      }
    );
  });

  it('should support transactions with return values', async () => {
    await fc.asyncProperty(
      fc.constantFrom(...DRIVERS),
      fc.constantFrom(...WORKERS),
      async (driver, workers) => {
        const db = new DB({ filename: ':memory:', driver, workers });

        await db.exec`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`;

        const name = fc.stringOf(fc.hexa(), { minLength: 1, maxLength: 10 })();

        const user = await db.transaction(async (tx) => {
          const insert = await tx.run`INSERT INTO users (name) VALUES (${name})`;
          const result = await tx.get`SELECT * FROM users WHERE id = ${insert.lastInsertRowid}`;
          return result;
        });

        assert.deepEqual(user.name, name);

        const all = await db.all`SELECT * FROM users`;
        assert.deepEqual(all.length, 1);

        await db.close();
      }
    );
  });

  it('should rollback on transaction error', async () => {
    await fc.asyncProperty(
      fc.constantFrom(...DRIVERS),
      fc.constantFrom(...WORKERS),
      async (driver, workers) => {
        const db = new DB({ filename: ':memory:', driver, workers });

        await db.exec`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT UNIQUE)`;

        await assert.rejects(
          () => db.transaction(async (tx) => {
            await tx.run`INSERT INTO test (name) VALUES (${'alice'})`;
            await tx.run`INSERT INTO test (name) VALUES (${'alice'})`; // duplicate
          }),
          /SQLITE_CONSTRAINT/
        );

        const rows = await db.all`SELECT * FROM test`;
        assert.deepEqual(rows.length, 1); // first insert succeeded, second failed → rollback

        await db.close();
      }
    );
  });

  it('should handle concurrent operations safely', async () => {
    // Simplified concurrency test with random ops
    await fc.asyncProperty(
      fc.constantFrom(...DRIVERS),
      fc.constantFrom(...WORKERS),
      fc.integer({ min: 1, max: 5 }), // num concurrent ops
      async (driver, workers, numOps) => {
        const db = new DB({ filename: ':memory:', driver, workers });

        await db.exec`CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER)`;
        await db.run`INSERT INTO counter (value) VALUES (0)`;

        const promises = [];
        for (let i = 0; i < numOps; i++) {
          promises.push(
            db.transaction(async (tx) => {
              const current = await tx.get`SELECT value FROM counter LIMIT 1`;
              await tx.run`UPDATE counter SET value = ${current.value + 1}`;
              return current.value + 1;
            })
          );
        }

        const results = await Promise.all(promises);
        const final = await db.get`SELECT value FROM counter LIMIT 1`;

        // Each op should increment by 1, total should be numOps
        assert.deepEqual(final.value, numOps);
        assert.deepEqual(results, Array.from({ length: numOps }, (_, i) => i + 1));

        await db.close();
      }
    );
  });

  it('should handle empty queries and no results', async () => {
    await fc.asyncProperty(
      fc.constantFrom(...DRIVERS),
      fc.constantFrom(...WORKERS),
      async (driver, workers) => {
        const db = new DB({ filename: ':memory:', driver, workers });

        await db.exec`CREATE TABLE empty_test (id INTEGER PRIMARY KEY)`;

        const result = await db.get`SELECT * FROM empty_test WHERE 1 = 0`;
        assert.strictEqual(result, undefined);

        const all = await db.all`SELECT * FROM empty_test WHERE 1 = 0`;
        assert.deepEqual(all, []);

        await db.close();
      }
    );
  });
});