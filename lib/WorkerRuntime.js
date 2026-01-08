import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

/**
 * Runs inside a worker thread.
 * Owns the SQLite connection and executes DB jobs sequentially.
 */
export class WorkerRuntime {
  #db;
  #sql;

  constructor({ filename, options }) {
    this.#db = new DatabaseSync(filename, options);
    this.#sql = this.#db.createTagStore();
  }

  start() {
    parentPort.on('message', (job) => {
      try {
        const result = this.#handle(job);
        parentPort.postMessage({ id: job.id, result });
      } catch (err) {
        parentPort.postMessage({
          id: job.id,
          error: this.#serializeError(err)
        });
      }
    });
  }

  #handle(job) {
    let split_sql;
    if (typeof job.sql === "string") {
      split_sql = job.sql?.split('?');
    } else if (job.sql instanceof Array) {
      split_sql = job.sql;
    }
    
    switch (job.method) {
      case 'beginTransaction':
        this.#db.exec('BEGIN IMMEDIATE'); // or 'BEGIN'
        return undefined;

      case 'commit':
        this.#db.exec('COMMIT');
        return undefined;

      case 'rollback':
        this.#db.exec('ROLLBACK');
        return undefined;
      case 'exec':
        return this.#db.exec(split_sql[0]);

      case 'run':
        return this.#sql.run(split_sql, ...job.values);

      case 'get':
        return this.#sql.get(split_sql, ...job.values);

      case 'all':
        return this.#sql.all(split_sql, ...job.values);

      case 'transaction':
        return this.#runTransaction(job.steps);

      default:
        throw new Error(`Unknown DB method: ${job.method}`);
    }
  }

  #runTransaction(steps) {
    this.#db.exec('BEGIN');
    try {
      let result;
      for (const step of steps) {
        result = this.#handle(step);
      }
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
      throw err;
    }
  }

  #serializeError(err) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack
    };
  }
}
