// lib/workers/better.worker.js
import { parentPort, workerData } from 'node:worker_threads';
import { BetterRuntime } from '../BetterRuntime.js';

const runtime = new BetterRuntime({
  filename: workerData.filename,
  options: workerData.options
});

runtime.start();

// Message protocol – identical to node:sqlite worker
parentPort.on('message', async (job) => {
  try {
    const result = globalThis.handleJob(job);
    parentPort.postMessage({ id: job.id, result });
  } catch (err) {
    parentPort.postMessage({
      id: job.id,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack
      }
    });
  }
});

// Graceful shutdown
parentPort.on('close', () => {
  runtime.close();
});