import { Worker } from 'node:worker_threads';

/**
 * Wraps a Node.js Worker and manages a single inflight DB job.
 */
export class DBWorker {
  #worker;
  #busy = false;
  #inflight = null;
  #closed = false;

  constructor(workerPath, options) {
    this.#worker = new Worker(workerPath, options);

    this.#worker.on('message', (msg) => {
      if (!this.#inflight || this.#inflight.id !== msg.id) {
        return; // Ignore stray or late messages
      }

      const { resolve, reject } = this.#inflight;
      this.#busy = false;
      this.#inflight = null;

      if (msg.error) {
        reject(this.#deserializeError(msg.error));
      } else {
        resolve(msg.result);
      }
    });

    this.#worker.on('error', (err) => {
      if (this.#inflight) {
        this.#inflight.reject(err);
        this.#inflight = null;
      }
      this.#busy = false;
    });
  }

  get busy() {
    return this.#busy;
  }

  get closed() {
    return this.#closed;
  }

  run(payload) {
    if (this.#busy) {
      throw new Error('Worker is already busy');
    }

    this.#busy = true;

    return new Promise((resolve, reject) => {
      this.#inflight = {
        id: payload.id,
        resolve,
        reject
      };
      this.#worker.postMessage(payload);
    });
  }

  async terminate() {
    await this.#worker.terminate();
    this.#closed = true;
  }

  #deserializeError(err) {
    const e = new Error(err.message);
    e.name = err.name;
    e.stack = err.stack;
    return e;
  }
}
