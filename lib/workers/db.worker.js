import { WorkerRuntime } from '../WorkerRuntime.js';
import { workerData } from 'node:worker_threads';


const runtime = new WorkerRuntime({
  filename: workerData.filename,
  options: workerData.options
});

runtime.start();
