import { expect } from 'chai';
import nock from 'nock';

import CollectionApi, { PAGE_SIZE, RunChangedError } from './index.js';

const BASE_URL = 'http://127.0.0.1:3000/collection-api/v1';
const RUN_ID = 'ota-run-11111111-58cc-4372-a567-0e02b2c3d479';
const OTHER_RUN_ID = 'ota-run-22222222-58cc-4372-a567-0e02b2c3d479';
const RUN = { runId: RUN_ID, lastRun: { status: 'completed' } };

function makeResult(index) {
  return { serviceId: `Service ${index}`, termsType: 'Terms of Service', declared: true, status: 'ok', event: {} };
}

describe('CollectionApi', () => {
  const collectionApi = new CollectionApi(`${BASE_URL}/`);

  afterEach(nock.cleanAll);

  describe('#assertServesTrackingResults', () => {
    context('when tracking results are served', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results').query({ limit: '1' }).reply(200, { runId: null, data: [], count: 0, limit: 1, offset: 0 });
      });

      it('resolves', async () => {
        await expect(collectionApi.assertServesTrackingResults()).to.be.fulfilled;
      });
    });

    context('when the Collection API does not expose tracking results', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results').query({ limit: '1' }).reply(404, { error: 'Not found' });
      });

      it('rejects with an explanation', async () => {
        await expect(collectionApi.assertServesTrackingResults()).to.be.rejectedWith('does not expose tracking results');
      });
    });

    context('when the responses do not identify the run they reflect', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results').query({ limit: '1' }).reply(200, { data: [], count: 0, limit: 1, offset: 0 });
      });

      it('rejects with the minimum engine version', async () => {
        await expect(collectionApi.assertServesTrackingResults()).to.be.rejectedWith('16.4.0');
      });
    });
  });

  describe('#getLatestCompletedRun', () => {
    context('when a run has completed', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results/run').reply(200, RUN);
      });

      it('returns the run', async () => {
        expect(await collectionApi.getLatestCompletedRun()).to.deep.equal(RUN);
      });
    });

    context('when no run has completed yet', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results/run').reply(404, { error: 'No tracking run has completed yet' });
      });

      it('returns null', async () => {
        expect(await collectionApi.getLatestCompletedRun()).to.be.null;
      });
    });

    context('when the Collection API fails', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results/run').reply(500, { error: 'Internal Server Error' });
      });

      it('rejects with the response status', async () => {
        await expect(collectionApi.getLatestCompletedRun()).to.be.rejectedWith('status 500');
      });
    });
  });

  describe('#getTrackingResults', () => {
    context('when the tracking results span several pages', () => {
      const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => makeResult(index));
      const lastResult = makeResult(PAGE_SIZE);

      before(() => {
        nock(BASE_URL).get('/tracking-results').query({ limit: String(PAGE_SIZE), offset: '0' }).reply(200, { runId: RUN_ID, data: firstPage, count: PAGE_SIZE + 1, limit: PAGE_SIZE, offset: 0 });
        nock(BASE_URL).get('/tracking-results').query({ limit: String(PAGE_SIZE), offset: String(PAGE_SIZE) }).reply(200, { runId: RUN_ID, data: [lastResult], count: PAGE_SIZE + 1, limit: PAGE_SIZE, offset: PAGE_SIZE });
      });

      it('returns the tracking results of all pages in order', async () => {
        expect(await collectionApi.getTrackingResults(RUN_ID)).to.deep.equal([ ...firstPage, lastResult ]);
      });
    });

    context('when there is no tracking result', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results').query({ limit: String(PAGE_SIZE), offset: '0' }).reply(200, { runId: RUN_ID, data: [], count: 0, limit: PAGE_SIZE, offset: 0 });
      });

      it('returns an empty list', async () => {
        expect(await collectionApi.getTrackingResults(RUN_ID)).to.deep.equal([]);
      });
    });

    context('when a run completes between two pages', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results').query({ limit: String(PAGE_SIZE), offset: '0' }).reply(200, { runId: RUN_ID, data: Array.from({ length: PAGE_SIZE }, (_, index) => makeResult(index)), count: PAGE_SIZE + 1, limit: PAGE_SIZE, offset: 0 });
        nock(BASE_URL).get('/tracking-results').query({ limit: String(PAGE_SIZE), offset: String(PAGE_SIZE) }).reply(200, { runId: OTHER_RUN_ID, data: [makeResult(PAGE_SIZE)], count: PAGE_SIZE + 1, limit: PAGE_SIZE, offset: PAGE_SIZE });
      });

      it('rejects rather than mixing the results of two runs', async () => {
        await expect(collectionApi.getTrackingResults(RUN_ID)).to.be.rejectedWith(RunChangedError);
      });
    });

    context('when the tracking results reflect another run than expected', () => {
      before(() => {
        nock(BASE_URL).get('/tracking-results').query({ limit: String(PAGE_SIZE), offset: '0' }).reply(200, { runId: OTHER_RUN_ID, data: [], count: 0, limit: PAGE_SIZE, offset: 0 });
      });

      it('rejects', async () => {
        await expect(collectionApi.getTrackingResults(RUN_ID)).to.be.rejectedWith(RunChangedError);
      });
    });
  });
});
