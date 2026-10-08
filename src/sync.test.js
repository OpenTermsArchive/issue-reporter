import { expect } from 'chai';
import sinon from 'sinon';

import { RunChangedError } from './collection-api/index.js';
import logger from './logger.js';
import { Synchronizer, isRunStale, STALE_RUN_TOLERANCE } from './sync.js';

const RUN = {
  runId: 'ota-run-11111111-58cc-4372-a567-0e02b2c3d479',
  schedule: '30 */12 * * *',
  lastRun: { endDate: '2026-04-06T10:42:34Z', status: 'completed' },
  declarations: { terms: 2 },
};
const NEXT_RUN = { ...RUN, runId: 'ota-run-22222222-58cc-4372-a567-0e02b2c3d479' };
const RESULTS = [{ serviceId: 'Service A', termsType: 'Terms of Service', declared: true, status: 'ok', event: {} }];

describe('Synchronizer', () => {
  let collectionApi;
  let reporter;
  let synchronizer;

  beforeEach(() => {
    collectionApi = { getLatestCompletedRun: sinon.stub(), getTrackingResults: sinon.stub().resolves(RESULTS) };
    reporter = { sync: sinon.stub().resolves() };
    synchronizer = new Synchronizer({ collectionApi, reporter });
  });

  describe('#synchronize', () => {
    context('when no run has completed yet', () => {
      beforeEach(async () => {
        collectionApi.getLatestCompletedRun.resolves(null);
        await synchronizer.synchronize();
      });

      it('does not report anything', () => {
        expect(reporter.sync).to.not.have.been.called;
      });
    });

    context('when a run has completed', () => {
      beforeEach(async () => {
        collectionApi.getLatestCompletedRun.resolves(RUN);
        await synchronizer.synchronize();
      });

      it('reads the tracking results of that run', () => {
        expect(collectionApi.getTrackingResults).to.have.been.calledOnceWith(RUN.runId);
      });

      it('reports the tracking results of that run', () => {
        expect(reporter.sync).to.have.been.calledOnceWith({ run: RUN, results: RESULTS });
      });

      context('and the synchronization runs again before the next run completes', () => {
        beforeEach(() => synchronizer.synchronize());

        it('does not report the same run twice', () => {
          expect(reporter.sync).to.have.been.calledOnce;
        });
      });

      context('and the next run completes', () => {
        beforeEach(async () => {
          collectionApi.getLatestCompletedRun.resolves(NEXT_RUN);
          await synchronizer.synchronize();
        });

        it('reports the tracking results of the next run', () => {
          expect(reporter.sync).to.have.been.calledTwice;
          expect(reporter.sync.secondCall).to.have.been.calledWith({ run: NEXT_RUN, results: RESULTS });
        });
      });
    });

    context('when some tracking results could not be reported', () => {
      const error = new Error('1 of 1 tracking results could not be reported');

      beforeEach(() => {
        collectionApi.getLatestCompletedRun.resolves(RUN);
        reporter.sync.onFirstCall().rejects(error);
      });

      it('rejects', async () => {
        await expect(synchronizer.synchronize()).to.be.rejectedWith(error);
      });

      it('reports the same run again at the next synchronization', async () => {
        await synchronizer.synchronize().catch(() => {});
        await synchronizer.synchronize();

        expect(reporter.sync).to.have.been.calledTwice;
      });
    });

    context('when a run completes while the tracking results are being read', () => {
      beforeEach(async () => {
        collectionApi.getLatestCompletedRun.onFirstCall().resolves(RUN).onSecondCall().resolves(NEXT_RUN);
        collectionApi.getTrackingResults.onFirstCall().rejects(new RunChangedError('The Collection API now serves the tracking results of another run'));
        await synchronizer.synchronize();
      });

      it('restarts the synchronization with the run that just completed', () => {
        expect(reporter.sync).to.have.been.calledOnceWith({ run: NEXT_RUN, results: RESULTS });
      });
    });
  });

  describe('#checkStaleness', () => {
    const now = new Date('2026-04-08T10:00:00Z'); // Almost two days after the run completed, while runs are scheduled every twelve hours

    beforeEach(() => {
      sinon.stub(logger, 'error');
    });

    afterEach(() => {
      logger.error.restore();
    });

    context('when no run has completed for too long', () => {
      beforeEach(() => {
        synchronizer.checkStaleness(RUN, now);
      });

      it('reports an error', () => {
        expect(logger.error).to.have.been.calledOnce;
      });

      it('reports the same stale run only once', () => {
        synchronizer.checkStaleness(RUN, now);

        expect(logger.error).to.have.been.calledOnce;
      });

      it('reports a new stale run', () => {
        synchronizer.checkStaleness(NEXT_RUN, now);

        expect(logger.error).to.have.been.calledTwice;
      });
    });

    context('when the latest run completed recently', () => {
      beforeEach(() => {
        synchronizer.checkStaleness(RUN, new Date('2026-04-06T20:00:00Z'));
      });

      it('does not report any error', () => {
        expect(logger.error).to.not.have.been.called;
      });
    });
  });
});

describe('isRunStale', () => {
  const now = new Date('2026-04-07T10:00:00Z');
  const twelveHours = 12 * 60 * 60 * 1000;

  it('is false when the run completed less than the tolerated number of schedule intervals ago', () => {
    expect(isRunStale({ ...RUN, lastRun: { endDate: new Date(now - STALE_RUN_TOLERANCE * twelveHours + 60 * 1000).toISOString() } }, now)).to.be.false;
  });

  it('is true when the run completed more than the tolerated number of schedule intervals ago', () => {
    expect(isRunStale({ ...RUN, lastRun: { endDate: new Date(now - STALE_RUN_TOLERANCE * twelveHours - 60 * 1000).toISOString() } }, now)).to.be.true;
  });

  it('is false when the tracking is not scheduled', () => {
    expect(isRunStale({ ...RUN, schedule: null, lastRun: { endDate: '2020-01-01T00:00:00Z' } }, now)).to.be.false;
  });

  context('with an irregular schedule', () => { // Two runs an hour apart in the morning, then nothing until the next day
    const run = { ...RUN, schedule: '0 9,10 * * *' };

    it('is false right after the short interval, as the long one is the one to wait for', () => {
      expect(isRunStale({ ...run, lastRun: { endDate: new Date(now - 5 * 60 * 60 * 1000).toISOString() } }, now)).to.be.false;
    });

    it('is true once the long interval elapsed more than the tolerated number of times', () => {
      expect(isRunStale({ ...run, lastRun: { endDate: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString() } }, now)).to.be.true;
    });
  });
});
