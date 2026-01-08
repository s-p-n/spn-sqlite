// lib/BetterRuntime.js
import Database from 'better-sqlite3';

export class BetterRuntime {
  #db;
  #statements = new Map(); // Cache prepared statements by SQL string

  constructor({ filename, options = {} }) {
    this.#db = new Database(filename, options);
    this.#db.pragma('foreign_keys = ON');
  }

  start() {
    globalThis.handleJob = this.#handle.bind(this);
  }

  #getStatement(sql) {
    // Skip caching for multi-statement or complex SQL — just prepare fresh
    // But for single statements, cache aggressively
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  #handle(job) {
    const { method, sql, values = [], steps } = job;
    // Handle transaction control commands (no SQL needed)
    if (method === 'beginTransaction') {
      this.#db.exec('BEGIN IMMEDIATE');
      return undefined;
    }
    if (method === 'commit') {
      this.#db.exec('COMMIT');
      return undefined;
    }
    if (method === 'rollback') {
      this.#db.exec('ROLLBACK');
      return undefined;
    }
    
    if (method === 'transaction') {
      return this.#runTransaction(steps);
    }

    // Special handling for exec — better-sqlite3 allows multi-statement here
    if (method === 'exec') {
      this.#db.exec(sql); // This supports multiple statements!
      return undefined;
    }

    // For run/get/all — use prepared statements (single statement only)
    const stmt = this.#getStatement(sql);

    switch (method) {
      case 'beginTransaction':
        this.#db.exec('BEGIN IMMEDIATE'); // or 'BEGIN'
        return undefined;

      case 'commit':
        this.#db.exec('COMMIT');
        return undefined;

      case 'rollback':
        this.#db.exec('ROLLBACK');
        return undefined;
      case 'run':
        const info = stmt.run(...values);
        return {
          changes: info.changes,
          lastInsertRowid: info.lastInsertRowid
        };

      case 'get':
        return stmt.get(...values) ?? undefined;

      case 'all':
        return stmt.all(...values);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  #runTransaction(steps) {
    const transaction = this.#db.transaction(() => {
      let lastResult;
      for (const step of steps) {
        lastResult = this.#handle(step);
      }
      return lastResult;
    });
    return transaction();
  }

  close() {
    this.#db.close();
  }
}