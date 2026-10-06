import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch from 'node-fetch';

import { LABELS, MANAGED_BY_OTA_MARKER, DEPRECATED_MANAGED_BY_OTA_MARKER } from '../labels.js';
import logger from '../logger.js';

const BASE_URL = 'https://gitlab.com';
const API_BASE_URL = 'https://gitlab.com/api/v4';
const AUTHENTICATION_FAILURE_STATUSES = [ 401, 403 ];

export default class GitLab {
  static TOKEN_ENVIRONMENT_VARIABLE = 'OTA_ISSUE_REPORTER_GITLAB_TOKEN';
  static ISSUE_STATE_CLOSED = 'closed';
  static ISSUE_STATE_OPEN = 'opened';
  static ISSUE_STATE_ALL = 'all';
  static MAX_LABEL_DESCRIPTION_LENGTH = 255;

  constructor(repositories, baseURL = BASE_URL, apiBaseURL = API_BASE_URL) {
    this.repositories = repositories; // Each generated link points into its own repository, while the issues live in the declarations one
    this.projectId = null;
    this.baseURL = baseURL;
    this.apiBaseURL = apiBaseURL;
    this.MANAGED_LABELS = Object.values(LABELS);

    this.issuesCache = new Map();
    this._issuesPromise = null;
  }

  get issues() {
    if (!this._issuesPromise) {
      logger.info('Loading issues from GitLab…');
      this._issuesPromise = this.loadAllIssues();
    }

    return this._issuesPromise;
  }

  clearCache() {
    this.issuesCache.clear();
    this._issuesPromise = null;
  }

  loadIssues() { // Drops the issues known from the previous synchronization and loads them all again
    this.clearCache();

    return this.issues;
  }

  async initialize() {
    const { id } = await this.request('GET', `/projects/${encodeURIComponent(this.repositories.declarations)}`); // Fails fast, as nothing can be done without the project

    this.projectId = id;

    try {
      let existingLabels = await this.getRepositoryLabels();
      const labelsToRemove = existingLabels.filter(label => label.description && label.description.includes(DEPRECATED_MANAGED_BY_OTA_MARKER));

      if (labelsToRemove.length) {
        logger.info(`Removing labels with deprecated markers: ${labelsToRemove.map(label => `"${label.name}"`).join(', ')}`);

        for (const label of labelsToRemove) {
          await this.deleteLabel(label.name);
        }
      }

      if (labelsToRemove.length) {
        existingLabels = await this.getRepositoryLabels();
      }

      const managedLabelsNames = this.MANAGED_LABELS.map(label => label.name);
      const obsoleteManagedLabels = existingLabels.filter(label => label.description?.includes(MANAGED_BY_OTA_MARKER) && !managedLabelsNames.includes(label.name));

      if (obsoleteManagedLabels.length) {
        logger.info(`Removing obsolete managed labels: ${obsoleteManagedLabels.map(label => `"${label.name}"`).join(', ')}`);

        for (const label of obsoleteManagedLabels) {
          await this.deleteLabel(label.name);
        }
      }

      if (obsoleteManagedLabels.length) {
        existingLabels = await this.getRepositoryLabels();
      }

      const existingLabelsNames = existingLabels.map(label => label.name);
      const missingLabels = this.MANAGED_LABELS.filter(label => !existingLabelsNames.includes(label.name));

      if (missingLabels.length) {
        logger.info(`Following required labels are not present on the repository: ${missingLabels.map(label => `"${label.name}"`).join(', ')}. Creating them…`);

        for (const label of missingLabels) {
          await this.createLabel({
            name: label.name,
            color: `#${label.color}`,
            description: `${label.description} ${MANAGED_BY_OTA_MARKER}`,
          });
        }
      }

      const labelsToUpdate = this.MANAGED_LABELS.filter(label => {
        const existingLabel = existingLabels.find(existingLabel => existingLabel.name === label.name);

        if (!existingLabel) {
          return false;
        }

        const expectedDescription = `${label.description} ${MANAGED_BY_OTA_MARKER}`;
        const expectedColor = `#${label.color}`;

        return existingLabel.description !== expectedDescription || existingLabel.color !== expectedColor;
      });

      if (labelsToUpdate.length) {
        logger.info(`Updating labels with changed descriptions: ${labelsToUpdate.map(label => `"${label.name}"`).join(', ')}`);

        for (const label of labelsToUpdate) {
          await this.updateLabel({
            name: label.name,
            color: `#${label.color}`,
            description: `${label.description} ${MANAGED_BY_OTA_MARKER}`,
          });
        }
      }
    } catch (error) {
      if (AUTHENTICATION_FAILURE_STATUSES.includes(error.status)) { // A rejected token would fail every synchronization, so it is better reported at startup
        throw error;
      }

      logger.error(`Failed to handle repository labels: ${error.message}`);
    }
  }

  async loadAllIssues() {
    try {
      let count = 0;

      for (let page = 1; page;) {
        const { data: issues, nextPage } = await this.requestPage('GET', `/projects/${this.projectId}/issues`, { query: { scope: 'all', state: GitLab.ISSUE_STATE_ALL, per_page: 100, page } });

        issues.forEach(issue => {
          const cachedIssue = this.issuesCache.get(issue.title);

          if (!cachedIssue || new Date(issue.created_at) < new Date(cachedIssue.created_at)) { // Only work on the oldest issue if there are duplicates, in order to consolidate the longest history possible
            this.issuesCache.set(issue.title, issue);
          }
        });

        count += issues.length;
        page = nextPage;
      }

      logger.info(`Cached ${count} issues from the GitLab project`);

      return this.issuesCache;
    } catch (error) {
      logger.error(`Failed to load issues: ${error.message}`);
      throw error;
    }
  }

  getRepositoryLabels() {
    return this.request('GET', `/projects/${this.projectId}/labels`, { query: { with_counts: true } });
  }

  async createLabel({ name, color, description }) {
    const label = await this.request('POST', `/projects/${this.projectId}/labels`, { body: { name, color, description } });

    logger.info(`New label created: ${label.name} , color: ${label.color}`);
  }

  async deleteLabel(name) {
    await this.request('DELETE', `/projects/${this.projectId}/labels/${encodeURIComponent(name)}`);

    logger.info(`Label deleted: ${name}`);
  }

  async updateLabel({ name, color, description }) {
    const label = await this.request('PUT', `/projects/${this.projectId}/labels/${encodeURIComponent(name)}`, { body: { name, color, description } });

    logger.info(`Label updated: ${label.name}, color: ${label.color}`);
  }

  async getIssue(title) {
    return (await this.issues).get(title);
  }

  async createIssue({ title, description, labels }) {
    const issue = await this.request('POST', `/projects/${this.projectId}/issues`, { body: { title, description, labels } });

    this.issuesCache.set(issue.title, issue);

    return issue;
  }

  async updateIssue(issue, { stateEvent, labels }) { // GitLab changes the state of an issue through a `state_event` rather than a target state
    const body = {};

    if (stateEvent) {
      body.state_event = stateEvent;
    }

    if (labels) {
      body.labels = labels;
    }

    const updatedIssue = await this.request('PUT', `/projects/${this.projectId}/issues/${issue.iid}`, { body });

    this.issuesCache.set(updatedIssue.title, updatedIssue);

    return updatedIssue;
  }

  addCommentToIssue({ issue, comment }) {
    return this.request('POST', `/projects/${this.projectId}/issues/${issue.iid}/notes`, { body: { body: comment } });
  }

  async closeIssueWithCommentIfExists({ title, comment }) {
    const issue = await this.getIssue(title);

    if (!issue || issue.state !== GitLab.ISSUE_STATE_OPEN) {
      return;
    }

    await this.addCommentToIssue({ issue, comment });
    await this.updateIssue(issue, { stateEvent: 'close' });

    logger.info(`Closed issue with comment #${issue.iid}: ${issue.web_url}`);
  }

  async createOrUpdateIssue({ title, description, labels }) {
    const issue = await this.getIssue(title);

    if (!issue) {
      const createdIssue = await this.createIssue({ title, description, labels });

      return logger.info(`Created issue #${createdIssue.iid} "${title}": ${createdIssue.web_url}`);
    }

    const managedLabelsNames = this.MANAGED_LABELS.map(label => label.name);
    const issueLabelsNames = issue.labels.map(label => (typeof label == 'string' ? label : label.name)); // The GitLab API lists the labels of an issue by name, and as objects when label details are requested
    const labelsNotManagedToKeep = issueLabelsNames.filter(label => !managedLabelsNames.includes(label));
    const managedLabels = issueLabelsNames.filter(label => managedLabelsNames.includes(label));

    if (issue.state !== GitLab.ISSUE_STATE_CLOSED && labels.every(label => managedLabels.includes(label))) {
      return; // if all requested labels are already assigned to the issue, the error is redundant with the one already reported and no further action is necessary
    }

    await this.updateIssue(issue, {
      stateEvent: issue.state == GitLab.ISSUE_STATE_CLOSED ? 'reopen' : undefined,
      labels: [ ...labels, ...labelsNotManagedToKeep ],
    });

    await this.addCommentToIssue({ issue, comment: description });

    logger.info(`Updated issue with comment #${issue.iid}: ${issue.web_url}`);
  }

  async request(method, path, { query, body } = {}) {
    const { data } = await this.requestPage(method, path, { query, body });

    return data;
  }

  async requestPage(method, path, { query, body } = {}) { // Resolves to the parsed response body along with the number of the next page when the endpoint is paginated
    const url = new URL(`${this.apiBaseURL}${path}`);

    Object.entries(query || {}).forEach(([ name, value ]) => url.searchParams.set(name, value));

    const options = { ...GitLab.baseOptionsHttpReq(), method };

    if (body) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }

    const response = await nodeFetch(url, options);
    const text = await response.text();

    if (!response.ok) { // Checked before parsing, as an error body may not be JSON, such as the page of a proxy
      throw Object.assign(new Error(`GitLab API responded with status ${response.status} to ${method} ${url.pathname}: ${text}`), { status: response.status });
    }

    return { data: text ? JSON.parse(text) : null, nextPage: Number(response.headers.get('x-next-page')) || null }; // A deletion answers with an empty body
  }

  static baseOptionsHttpReq(token = process.env[GitLab.TOKEN_ENVIRONMENT_VARIABLE]) {
    const options = {};

    if (process.env.HTTPS_PROXY) {
      options.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    } else if (process.env.HTTP_PROXY) {
      options.agent = new HttpProxyAgent(process.env.HTTP_PROXY);
    }

    options.headers = { Authorization: `Bearer ${token}` };

    return options;
  }

  generateDeclarationURL(serviceId) {
    return `${this.baseURL}/${this.repositories.declarations}/-/blob/main/declarations/${encodeURIComponent(serviceId)}.json`;
  }

  generateVersionURL(serviceId, termsType) {
    return `${this.baseURL}/${this.repositories.versions}/-/blob/main/${encodeURIComponent(serviceId)}/${encodeURIComponent(termsType)}.md`;
  }

  generateSnapshotsBaseUrl(serviceId, termsType) {
    return `${this.baseURL}/${this.repositories.snapshots}/-/blob/main/${encodeURIComponent(serviceId)}/${encodeURIComponent(termsType)}`;
  }
}
