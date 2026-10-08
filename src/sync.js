import config from 'config';
import { Cron } from 'croner';
import cronstrue from 'cronstrue';

import CollectionApi, { RunChangedError } from './collection-api/index.js';
import logger from './logger.js';

import Reporter from './index.js';

export const STALE_RUN_TOLERANCE = 2; // Number of scheduled tracking intervals that may elapse without a completed run before alerting
const SAMPLED_RUNS = 48; // Enough scheduled runs to meet the longest interval of an irregular schedule, such as two runs an hour apart then nothing until the next day
const STARTUP_ATTEMPTS = 6; // The Collection API starts alongside the reporter on a deployment, so it may not answer yet
const STARTUP_RETRY_DELAY = 10 * 1000;

export default async function sync({ schedule } = {}) {
  const reporterConfig = config.get('@opentermsarchive/issue-reporter');
  const collectionApi = new CollectionApi(config.get('@opentermsarchive/issue-reporter.collectionApi.url'));
  const reporter = new Reporter(reporterConfig);

  await retry(() => collectionApi.assertServesTrackingResults(), { attempts: schedule ? STARTUP_ATTEMPTS : 1, delay: STARTUP_RETRY_DELAY });
  await reporter.initialize();

  const synchronizer = new Synchronizer({ collectionApi, reporter });

  if (!schedule) {
    await synchronizer.synchronize();

    return;
  }

  const syncSchedule = config.get('@opentermsarchive/issue-reporter.schedule');

  logger.info(`Issues will be synchronized with the tracking results ${cronstrue.toString(syncSchedule).toLowerCase()} in the timezone of this machine`);

  const synchronizeSafely = async () => {
    try {
      await synchronizer.synchronize();
    } catch (error) {
      logger.error(`Synchronization failed, it will be retried at the next check: ${error.stack}`);
    }
  };

  await synchronizeSafely(); // Right away, so that a deployment does not leave the issues out of sync until the next check

  new Cron( // eslint-disable-line no-new
    syncSchedule,
    { protect: job => logger.warn(`Synchronization scheduled at ${new Date().toISOString()} was skipped because the one started at ${job.currentRun().toISOString()} is still running`) },
    synchronizeSafely,
  );
}

export class Synchronizer {
  constructor({ collectionApi, reporter }) {
    this.collectionApi = collectionApi;
    this.reporter = reporter;
    this.lastSyncedRunId = null;
    this.staleRunReported = null;
  }

  async synchronize() {
    try {
      await this.synchronizeWithLatestRun();
    } catch (error) {
      if (!(error instanceof RunChangedError)) {
        throw error;
      }

      logger.warn(`${error.message}; restarting the synchronization`); // A run just completed, so the restarted synchronization reads it whole

      await this.synchronizeWithLatestRun();
    }
  }

  async synchronizeWithLatestRun() {
    const run = await this.collectionApi.getLatestCompletedRun();

    if (!run) {
      logger.info('No tracking run has completed yet; nothing to report');

      return;
    }

    this.checkStaleness(run);

    if (run.runId === this.lastSyncedRunId) {
      logger.info(`Issues are already synchronized with the latest completed run ${run.runId}`);

      return;
    }

    logger.info(`Synchronizing issues with the tracking results of run ${run.runId}, completed on ${run.lastRun.endDate}…`);

    const results = await this.collectionApi.getTrackingResults(run.runId);

    await this.reporter.sync({ run, results });

    this.lastSyncedRunId = run.runId; // Recorded only after a complete synchronization, so that a partial one is retried at the next check rather than at the next run

    logger.info(`Synchronized issues with the ${results.length} tracking results of run ${run.runId}`);
  }

  checkStaleness(run, now = new Date()) {
    if (!isRunStale(run, now)) {
      this.staleRunReported = null;

      return;
    }

    if (this.staleRunReported === run.runId) { // Reported once per stale run rather than at every check
      return;
    }

    this.staleRunReported = run.runId;
    logger.error(`No tracking run has completed since ${run.lastRun.endDate} although tracking is scheduled ${cronstrue.toString(run.schedule).toLowerCase()}; the tracker may be stopped or crashing, and the issues cannot reflect the current tracking status until it completes a run`);
  }
}

export function isRunStale(run, now = new Date()) { // A run is stale when more than STALE_RUN_TOLERANCE scheduled tracking intervals have elapsed since it completed; the longest interval of the schedule is taken, so that the verdict does not depend on the time of the check
  if (!run.schedule || !run.lastRun?.endDate) {
    return false;
  }

  const runs = new Cron(run.schedule).nextRuns(SAMPLED_RUNS, now);

  if (runs.length < 2) {
    return false;
  }

  const interval = Math.max(...runs.slice(1).map((date, index) => date - runs[index]));

  return now - new Date(run.lastRun.endDate) > STALE_RUN_TOLERANCE * interval;
}

async function retry(operation, { attempts, delay }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(); // eslint-disable-line no-return-await
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }

      logger.warn(`${error.message}; retrying in ${delay / 1000} seconds (attempt ${attempt} of ${attempts})`);
      await new Promise(resolve => { setTimeout(resolve, delay); });
    }
  }
}
