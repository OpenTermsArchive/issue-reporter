import mime from 'mime';

import { createForge } from './factory.js';
import { LABELS } from './labels.js';
import logger from './logger.js';

const CONTRIBUTION_TOOL_URL = 'https://contribute.opentermsarchive.org/en/service';
const DOC_URL = 'https://docs.opentermsarchive.org';

export const STATUSES = Object.freeze({ ok: 'ok', failed: 'failed' }); // Statuses of a tracking result, as the Collection API serves them

export const UNDECLARED_CLOSING_THRESHOLD = 0.9; // Share of the declared terms that must have a tracking result for the issues of terms reported as no longer declared to be closed: a Collection API started on an incomplete declarations directory reports terms as undeclared, and closing their issues would only reopen them all at the next run. The flag is computed by the Collection API from the declarations loaded at its start, so it is only accurate when the API restarts along with the tracker, as a deployment does

const ERROR_MESSAGE_TO_ISSUE_LABELS_MAP = {
  'has no match': [ LABELS.DOCUMENT_STRUCTURE_CHANGE.name, LABELS.NEEDS_INTERVENTION.name ],
  'HTTP code 404': [ LABELS.DOCUMENT_NOT_FOUND.name, LABELS.NEEDS_INTERVENTION.name ],
  'HTTP code 403': [LABELS.HTTP_403.name],
  'HTTP code 429': [LABELS.HTTP_429.name],
  'HTTP code 500': [LABELS.HTTP_500.name],
  'HTTP code 502': [LABELS.HTTP_502.name],
  'HTTP code 503': [LABELS.HTTP_503.name],
  'Timed out after': [LABELS.DOCUMENT_LOAD_TIMEOUT.name],
  EAI_AGAIN: [LABELS.DNS_LOOKUP_FAILURE.name],
  ENOTFOUND: [LABELS.DNS_RESOLUTION_FAILURE.name],
  'Response is empty': [LABELS.EMPTY_RESPONSE.name],
  'unable to verify the first certificate': [LABELS.SSL_INVALID.name],
  'certificate has expired': [LABELS.SSL_EXPIRED.name],
  'maximum redirect reached': [LABELS.TOO_MANY_REDIRECTS.name],
  'not a valid selector': [ LABELS.INVALID_SELECTOR.name, LABELS.NEEDS_INTERVENTION.name ],
  'empty content': [LABELS.EMPTY_CONTENT.name],
};

export function getLabelNamesFromReasons(reasons = []) { // Reasons carry the engine error messages, prefixed by their category
  const text = reasons.join('\n');

  return ERROR_MESSAGE_TO_ISSUE_LABELS_MAP[Object.keys(ERROR_MESSAGE_TO_ISSUE_LABELS_MAP).find(substring => text.includes(substring))] || [LABELS.UNKNOWN_FAILURE.name];
}

// In the following class, it is assumed that each issue is managed using its title as a unique identifier
export default class Reporter {
  constructor(config) {
    Reporter.validateConfiguration(config);

    this.forge = createForge(config);
    this.repositories = config.repositories;

    const tokenVariable = this.forge.constructor.TOKEN_ENVIRONMENT_VARIABLE;

    if (!process.env[tokenVariable]) {
      throw new Error(`Environment variable "${tokenVariable}" is required to manage issues on ${config.type}`);
    }
  }

  static validateConfiguration(config) {
    if (!config.repositories?.declarations) {
      throw new Error('Required configuration key "repositories.declarations" was not found; issues on the declarations repository cannot be created');
    }

    for (const [ type, repo ] of Object.entries(config.repositories)) {
      if (!repo.includes('/') || repo.includes('https://')) {
        throw new Error(`Configuration entry "repositories.${type}" is expected to be a string in the format <owner>/<repo>, but received: "${repo}"`);
      }
    }
  }

  initialize() {
    return this.forge.initialize();
  }

  async sync({ run, results }) { // Reconciles the issues with the tracking results of one completed run. An issue is only opened, updated or closed on the positive evidence of a tracking result and terms without result are left untouched, so the same run can be synchronized again safely
    await this.forge.loadIssues(); // Reloaded at each synchronization, as issues may have been edited by hand meanwhile

    const undeclaredCount = results.filter(result => !result.declared).length;
    const declaredCount = results.length - undeclaredCount;
    const closeUndeclared = declaredCount >= run.declarations.terms * UNDECLARED_CLOSING_THRESHOLD;

    if (undeclaredCount && !closeUndeclared) {
      logger.warn(`Only ${declaredCount} of the ${run.declarations.terms} declared terms have a tracking result; the issues of the ${undeclaredCount} terms reported as no longer declared are kept open, in case the Collection API was started on an incomplete declarations directory`);
    }

    let failures = 0;

    for (const result of results) {
      try {
        await this.report(result, { closeUndeclared });
      } catch (error) {
        failures++;
        logger.error(`Could not report the tracking result of ${result.serviceId} ${result.termsType}: ${error.stack}`);
      }
    }

    if (failures) {
      throw new Error(`${failures} of ${results.length} tracking results could not be reported`);
    }
  }

  report(result, { closeUndeclared }) {
    const title = Reporter.generateTitle(result.serviceId, result.termsType);

    if (!result.declared) {
      return closeUndeclared ? this.forge.closeIssueWithCommentIfExists({ title, comment: NO_LONGER_DECLARED_COMMENT }) : undefined;
    }

    if (result.status === STATUSES.failed) {
      return this.forge.createOrUpdateIssue({
        title,
        description: this.generateDescription(result),
        labels: getLabelNamesFromReasons(result.event.reasons),
      });
    }

    return this.forge.closeIssueWithCommentIfExists({ title, comment: generateTrackingResumedComment(result.event.date) });
  }

  generateDescription({ serviceId, termsType, event }) {
    const { serviceName, sourceDocuments, reasons } = event;
    const statusDate = new Date(event.date);
    const formattedStatusDate = formatDate(statusDate);
    const validUntil = toISODateWithoutMilliseconds(statusDate);
    const hasMultipleSourceDocuments = sourceDocuments.length > 1;
    const hasSnapshots = sourceDocuments.every(sourceDocument => sourceDocument.snapshotId);

    const contributionToolParams = new URLSearchParams({
      json: JSON.stringify(toDeclaration({ serviceName, termsType, sourceDocuments })),
      destination: this.repositories.declarations,
      step: '2',
    });
    const contributionToolUrl = `${CONTRIBUTION_TOOL_URL}?${contributionToolParams}`;

    const declarationFileUrl = this.forge.generateDeclarationURL(serviceId);
    const updateDeclarationLink = hasMultipleSourceDocuments ? `[on GitHub](${declarationFileUrl})` : `[on the contribution tool](${contributionToolUrl})`;
    const multiDocumentsUpdateInfo = hasMultipleSourceDocuments ? ' (the contribution tool does not support multi-document)' : '';

    const latestDeclarationLink = `[Latest declaration](${declarationFileUrl})`;
    const latestVersionLink = `[Latest version](${this.forge.generateVersionURL(serviceId, termsType)})`;
    const snapshotsBaseUrl = this.forge.generateSnapshotsBaseUrl(serviceId, termsType);
    const recordedSourceDocuments = sourceDocuments.filter(sourceDocument => sourceDocument.snapshotId); // A source document that has never been recorded has no snapshot file to link to, and its unknown MIME type would produce a link to a nonexistent ".null" file
    let latestSnapshotsLink = '';

    if (recordedSourceDocuments.length) {
      latestSnapshotsLink = hasMultipleSourceDocuments
        ? `Latest snapshots:\n  - ${recordedSourceDocuments.map(sourceDocument => `[${sourceDocument.id}](${snapshotsBaseUrl}.%20#${sourceDocument.id}.${mime.getExtension(sourceDocument.mimeType)})`).join('\n  - ')}`
        : `[Latest snapshot](${snapshotsBaseUrl}.${mime.getExtension(recordedSourceDocuments[0].mimeType)})`;
    }

    /* eslint-disable no-irregular-whitespace */
    return `
### No version of the \`${termsType}\` of service \`${serviceName}\` is recorded anymore

The tracking status last changed on ${formattedStatusDate}.

The source document${hasMultipleSourceDocuments ? 's have' : ' has'}${hasSnapshots ? ' ' : ' not '}been recorded as ${hasMultipleSourceDocuments ? 'snapshots' : 'a snapshot'}, ${hasSnapshots ? 'but ' : 'thus '} no version can be [extracted](${DOC_URL}/concepts/main/#tracking-terms).
${hasSnapshots ? 'After correction, it might still be possible to recover the missed versions.' : ''}

### What went wrong

- ${reasons.join('\n- ')}

### How to resume tracking

First of all, check if the source documents are accessible through a web browser:

- [ ] ${sourceDocuments.map(sourceDocument => `[${sourceDocument.fetch}](${sourceDocument.fetch})`).join('\n- [ ] ')}

#### If the source documents are accessible through a web browser

Edit the declaration ${updateDeclarationLink}${multiDocumentsUpdateInfo}:
- Try updating the selectors.
- Try switching client scripts on with expert mode.

#### If the source documents are not accessible anymore

- If the source documents have moved, find their new location and update it ${updateDeclarationLink}.
- If these terms have been removed, move them from the declaration to its [history file](${DOC_URL}/terms/explanation/declarations-maintenance/#service-history-reference), using \`${validUntil}\` as the \`validUntil\` value.
- If the service has closed, move the entire contents of the declaration to its [history file](${DOC_URL}/contributing-terms/#service-history), using \`${validUntil}\` as the \`validUntil\` value.

#### If none of the above works

If the source documents are accessible in a browser but fetching them always fails from the Open Terms Archive server, this is most likely because the service provider has blocked the Open Terms Archive robots from accessing its content. In this case, updating the declaration will not enable resuming tracking. Only an agreement with the service provider, an engine upgrade, or some technical workarounds provided by the administrator of this collection’s server might resume tracking.

### References

- ${latestDeclarationLink}
${this.repositories.versions ? `- ${latestVersionLink}` : ''}
${this.repositories.snapshots && latestSnapshotsLink ? `- ${latestSnapshotsLink}` : ''}
`;
  /* eslint-enable no-irregular-whitespace */
  }

  static generateTitle(serviceId, termsType) {
    return `\`${serviceId}\` ‧ \`${termsType}\` ‧ not tracked anymore`;
  }
}

const NO_LONGER_DECLARED_COMMENT = `### Tracking stopped

These terms are no longer declared in this collection.`;

function generateTrackingResumedComment(date) {
  return `### Tracking resumed

These terms have been tracked successfully since ${formatDate(new Date(date))}.`;
}

function toDeclaration({ serviceName, termsType, sourceDocuments }) { // Rebuilds the declaration the contribution tool expects from the declared fields that the tracking result carries for each source document
  const declarations = sourceDocuments.map(({ id, mimeType, snapshotId, ...declaration }) => declaration); // eslint-disable-line no-unused-vars

  return {
    name: serviceName,
    terms: { [termsType]: declarations.length > 1 ? { combine: declarations } : declarations[0] },
  };
}

function formatDate(date) {
  return date.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short', timeZone: 'UTC' });
}

function toISODateWithoutMilliseconds(date) {
  return date.toISOString().replace(/\.\d+/, '');
}
