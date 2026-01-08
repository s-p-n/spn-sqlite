import { DBDispatcher } from './DBDispatcher.js';
import { SQLCompiler } from './SQLCompiler.js';
import path from 'node:path';
import os from 'node:os';

/**
 * Public database API.
 * Promise-based, worker-backed SQLite driver.
 */
export class DB {
  #dispatcher;
  #inTransaction = false;

  /**
   * @param {object} options
   * @param {string} options.filename (defaults to ':memory:')
   * @param {string} options.driver (defaults to node:sqlite [experimental])
   * @param {object} [options.options] (driver options)
   * @param {number} [options.workers] (number of workers; defaults to 1)
   */
  constructor({
    filename = ":memory:",
    driver = "node:sqlite",
    options = {},
    workers = 1
  } = {
    filename: ":memory:",
    driver: "node:sqlite",
    options: {},
    workers: 1
  }) {
    const defaultWorkers = driver === "better-sqlite" 
      ? 1 
      : (filename === ':memory:' ? os.availableParallelism() : 2);

    const size = workers ?? defaultWorkers;

    this.#dispatcher = new DBDispatcher({
      workerPath: this.#getWorkerPath(driver),
      size,
      workerData: {
        filename,
        options
      }
    });
  }
  get inTransaction() {
    return this.#inTransaction;
  }
  close() {
    return this.#dispatcher.shutdown();
  }

  /* ───────────── Core query methods ───────────── */

  exec(strings, ...values) {
    if (values.length > 0) {
      throw new Error('exec() does not support parameters');
    }

    const sql = strings.join('');

    return this.#submit({
      method: 'exec',
      sql
    });
  }

  run(strings, ...values) {
    const { sql, values: bound } =
      SQLCompiler.compile(strings, values);

    return this.#submit({
      method: 'run',
      sql,
      values: bound
    });
  }

  get(strings, ...values) {
    const { sql, values: bound } =
      SQLCompiler.compile(strings, values);

    return this.#submit({
      method: 'get',
      sql,
      values: bound
    });
  }

  all(strings, ...values) {
    const { sql, values: bound } =
      SQLCompiler.compile(strings, values);

    return this.#submit({
      method: 'all',
      sql,
      values: bound
    });
  }

  /* ───────────── Transactions ───────────── */

  async transaction(fn) {
    const inTx = this.inTransaction; // we'll add this property

    if (inTx) {
      // Nested: just run the function (savepoints not needed for most cases)
      return await fn(this);
    }
    this.#inTransaction = true;
    try {
      await this.#submit({ method: 'beginTransaction' });
      const result = await fn(this);
      await this.#submit({ method: 'commit' });
      this.#inTransaction = false;
      return result;
    } catch (err) {
      await this.#submit({ method: 'rollback' }).catch(() => {}); // ignore rollback errors
      this.#inTransaction = false;
      throw err;
    }
  }

  /* ───────────── Internal ───────────── */

  #submit(job) {
    return this.#dispatcher.submit(job);
  }

  #getWorkerPath(driver) {
    switch (driver.replace('sqlite3', 'sqlite')) {
    case "better-sqlite":
      return path.join(import.meta.dirname, "./workers/better.worker.js");
    case "node:sqlite":
      return path.join(import.meta.dirname, "./workers/db.worker.js");
    default:
      throw new Error(`Sorry, the provided worker_driver "${driver}" is not supported.`);
    }
  }
}
