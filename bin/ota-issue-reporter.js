#! /usr/bin/env node
import './env.js';

import fs from 'fs';

import { program } from 'commander';

const { description, version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)).toString());

program
  .description(description)
  .version(version)
  .command('sync', 'Synchronize the issues of the declarations repository with the tracking results served by the Collection API')
  .parse(process.argv);
