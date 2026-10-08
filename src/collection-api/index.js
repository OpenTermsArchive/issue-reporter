import nodeFetch from 'node-fetch';

import { RunChangedError } from './errors.js';

export { RunChangedError } from './errors.js';

export const PAGE_SIZE = 500; // The largest page the Collection API serves
export const MINIMUM_ENGINE_VERSION = '16.4.0'; // The first engine version whose Collection API identifies the run its tracking results reflect

export default class CollectionApi {
  constructor(baseURL) {
    this.baseURL = baseURL.replace(/\/+$/, '');
  }

  async assertServesTrackingResults() { // Fails fast on a Collection API that can never be synchronized with, instead of waiting forever for a first run to complete
    const url = `${this.baseURL}/tracking-results?limit=1`;
    const response = await nodeFetch(url);

    if (response.status === 404) {
      throw new Error(`The Collection API at ${this.baseURL} does not expose tracking results; make sure tracking-results is enabled in the engine configuration and that the engine version is at least ${MINIMUM_ENGINE_VERSION}`);
    }

    if (!response.ok) {
      throw new Error(`The Collection API responded with status ${response.status} to GET ${url}`);
    }

    const { runId } = await response.json();

    if (runId === undefined) {
      throw new Error(`The Collection API at ${this.baseURL} does not identify the run its tracking results reflect; an engine version of at least ${MINIMUM_ENGINE_VERSION} is required`);
    }
  }

  async getLatestCompletedRun() { // Resolves to null until a first tracking run completes
    const url = `${this.baseURL}/tracking-results/run`;
    const response = await nodeFetch(url);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`The Collection API responded with status ${response.status} to GET ${url}`);
    }

    return response.json();
  }

  async getTrackingResults(runId) { // Every page is served as of the latest completed run, so a run completing between two pages would mix the states of two runs: each page is checked against the run expected by the caller
    const results = [];

    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await getJson(`${this.baseURL}/tracking-results?limit=${PAGE_SIZE}&offset=${offset}`);

      if (page.runId !== runId) {
        throw new RunChangedError(`The Collection API now serves the tracking results of run ${page.runId} instead of ${runId}`);
      }

      results.push(...page.data);

      if (results.length >= page.count || !page.data.length) {
        return results;
      }
    }
  }
}

async function getJson(url) {
  const response = await nodeFetch(url);

  if (!response.ok) {
    throw new Error(`The Collection API responded with status ${response.status} to GET ${url}`);
  }

  return response.json();
}
