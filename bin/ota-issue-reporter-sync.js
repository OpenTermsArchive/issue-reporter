#! /usr/bin/env node
import './env.js';

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { program } from 'commander';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sync = (await import(pathToFileURL(path.resolve(__dirname, '../src/sync.js')))).default; // load asynchronously to ensure env.js is loaded before

program
  .name('ota-issue-reporter sync')
  .description('Synchronize the issues of the declarations repository with the tracking results served by the Collection API')
  .option('--schedule', 'synchronize automatically at a regular interval');

try {
  await sync(program.parse(process.argv).opts());
} catch (error) {
  console.error(error.stack);
  process.exit(1);
}
