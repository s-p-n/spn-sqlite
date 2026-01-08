import { DBWorker as Worker } from './DBWorker.js';
import os from 'node:os';

/**
 * Dispatches DB jobs to a pool of worker threads.
 * Enforces FIFO ordering and single-job execution per worker.
 */
export class DBDispatcher {
  #workers = [];
  #queue = [];
  #nextJobId = 1;
  #closed = false;
  #workerShutdownComplete = false;

  /**
   * @param {object} options
   * @param {string} options.workerPath - Path to worker entry file
   * @param {number} [options.size] - Number of workers (default: 2)
   * @param {number} [options.maxQueue] - Max queued jobs (default: Infinity)
   */
  constructor({ workerPath, workerData, size = 2, maxQueue = Infinity }) {
    this.workerPath = workerPath;
    this.workerData = workerData;
    this.size = size;
    this.maxQueue = maxQueue;

    for (let i = 0; i < size; i++) {
      this.#workers.push(this.#createWorker());
    }
  }

  /**
   * Submits a job to a worker or queues it.
   * @param {object} job
   * @returns {Promise<any>}
   */
  submit(job) {
    if (this.#closed) {
      return Promise.reject(new Error('DBDispatcher is closed'));
    }

    if (this.#queue.length >= this.maxQueue) {
      return Promise.reject(new Error('DB queue is full'));
    }

    const id = this.#nextJobId++;
    const payload = { ...job, id };

    return new Promise(async (resolve, reject) => {
      this.#outsource({ payload, resolve, reject });
    });
  }

  /**
   * Gracefully shuts down all workers.
   */
  async shutdown() {
    this.#closed = true;

    // Reject queued jobs
    for (const entry of this.#queue) {
      entry.reject(new Error('DBDispatcher shutting down'));
    }
    this.#queue.length = 0;

    await Promise.all(
      this.#workers.map((w, i) => {
        if (!w.busy) {
          //this.#workers.splice(i, 1);
          //console.log('Will terminate idle worker:', i);
          return w.terminate();
        } else {
          //console.log(this.#workers.length, "workers are finishing up..")
          return this.#waitForWorkerShutdown();
        }
      })
    );
    //console.log(this.#workers.filter(w => !w.closed), "<-- the workers array should be empty now.");
  }

  /* ───────────── Internal helpers ───────────── */

  #createWorker() {
    return new Worker(this.workerPath, {
      workerData: this.workerData
    });
  }

  #getIdleWorker() {
    return this.#workers.find(w => !w.busy);
  }

  async #outsource(entry) {
    
    const worker = this.#getIdleWorker();
    if (worker) {
      if (this.#closed) {
        try {
          if (!worker.closed) {
            const index = this.#workers.indexOf(worker);
            await worker.terminate();
            //console.log('Terminated worker:', index);
          }
          let openWorkers = this.#workers.filter(w => !w.closed);
          if (openWorkers.length === 0) {
            this.#workerShutdownComplete = true;
          }
        } catch (err) {
          //console.error("Could not terminate worker after job! Possible data corruption!");
          //console.error(err);
        }
        return;
      }
      try {
        entry.resolve(await worker.run(entry.payload));
      } catch (err) {
        if (err.message === "database is locked") {
          this.#queue.unshift(entry);
        } else {
          //console.log(entry);
          console.error('Worker failed with payload:', entry.payload);
          entry.reject(err);
        }
      }
    } else {
      this.#queue.push(entry);
    }

    if (this.#queue.length) {
      const next_entry = this.#queue.shift();
      return setImmediate(() => this.#outsource(next_entry));
    }
  }

  #deserializeError(err) {
    const e = new Error(err.message);
    e.name = err.name;
    e.stack = err.stack;
    return e;
  }

  #waitForWorkerShutdown() {
    return new Promise((resolve) => {
      //console.log('waiting for workers to shut down..');
      const interval = setInterval(() => {
        if (this.#workerShutdownComplete) {
          clearInterval(interval);
          return resolve();
        }
        //console.log(this.#workers.length, "workers are too busy to shut down..");
      }, 10);
    });
  }
}
