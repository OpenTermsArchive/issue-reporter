import { expect } from 'chai';
import sinon from 'sinon';

import { LABELS } from './labels.js';

import Reporter, { getLabelNamesFromReasons, STATUSES } from './index.js';

const REPOSITORIES = { declarations: 'OpenTermsArchive/test-declarations', versions: 'OpenTermsArchive/test-versions', snapshots: 'OpenTermsArchive/test-snapshots' };
const RUN = { runId: 'ota-run-11111111-58cc-4372-a567-0e02b2c3d479', declarations: { terms: 4 } };
const STATUS_DATE = '2026-04-06T10:30:00Z';

function buildResult({ serviceId = 'TestService', serviceName = 'Test Service', termsType = 'Terms of Service', status = STATUSES.failed, declared = true, reasons = ['[fetch] HTTP code 404'], sourceCount = 1, hasSnapshots = true, withoutSnapshotIndexes = [] } = {}) {
  const sourceDocuments = Array.from({ length: sourceCount }, (_, index) => {
    const hasSnapshot = hasSnapshots && !withoutSnapshotIndexes.includes(index); // A document that has never been recorded has neither a snapshot ID nor an observed MIME type

    return {
      id: `source-${index}`,
      fetch: `https://example.com/source-${index}`,
      select: 'body',
      executeClientScripts: false,
      mimeType: hasSnapshot ? 'text/html' : null,
      snapshotId: hasSnapshot ? `snapshot-${index}` : null,
    };
  });

  const event = { date: STATUS_DATE, serviceName, sourceDocuments };

  if (status === STATUSES.failed) {
    event.reasons = reasons;
  }

  return { serviceId, termsType, declared, status, event };
}

describe('Reporter', () => {
  describe('#validateConfiguration', () => {
    context('with valid configuration', () => {
      it('does not throw an error', () => {
        expect(() => Reporter.validateConfiguration({ repositories: REPOSITORIES })).to.not.throw();
      });
    });

    context('with invalid configuration', () => {
      context('when declarations key is missing', () => {
        it('throws an error', () => {
          expect(() => Reporter.validateConfiguration({ repositories: { versions: 'owner/versions' } })).to.throw('"repositories.declarations"');
        });
      });

      context('when repository format is incorrect', () => {
        it('throws an error', () => {
          expect(() => Reporter.validateConfiguration({ repositories: { declarations: 'https://github.com/owner/repo' } })).to.throw('<owner>/<repo>');
        });
      });
    });
  });

  describe('constructor', () => {
    context('when the token of the forge is missing', () => {
      let token;

      before(() => {
        token = process.env.OTA_ISSUE_REPORTER_GITHUB_TOKEN;
        delete process.env.OTA_ISSUE_REPORTER_GITHUB_TOKEN;
      });

      after(() => {
        process.env.OTA_ISSUE_REPORTER_GITHUB_TOKEN = token;
      });

      it('throws an error naming the environment variable', () => {
        expect(() => new Reporter({ type: 'github', repositories: REPOSITORIES })).to.throw('OTA_ISSUE_REPORTER_GITHUB_TOKEN');
      });
    });

    context('when the type is not supported', () => {
      it('throws an error', () => {
        expect(() => new Reporter({ type: 'bitbucket', repositories: REPOSITORIES })).to.throw('Unsupported reporter type');
      });
    });
  });

  describe('.generateTitle', () => {
    it('identifies the terms by the service ID and the terms type', () => {
      expect(Reporter.generateTitle('TestService', 'Terms of Service')).to.equal('`TestService` ‧ `Terms of Service` ‧ not tracked anymore');
    });
  });

  describe('getLabelNamesFromReasons', () => {
    it('maps a known reason to its labels whatever its category prefix', () => {
      expect(getLabelNamesFromReasons(['[fetch] Received HTTP code 404 when trying to fetch https://example.com'])).to.deep.equal([ LABELS.DOCUMENT_NOT_FOUND.name, LABELS.NEEDS_INTERVENTION.name ]);
    });

    it('maps the first known reason when several reasons are given', () => {
      expect(getLabelNamesFromReasons([ '[fetch] Received HTTP code 403', '[fetch] Received HTTP code 404' ])).to.deep.equal([ LABELS.DOCUMENT_NOT_FOUND.name, LABELS.NEEDS_INTERVENTION.name ]); // Labels are looked up in the order of the known reasons, not in the order of the given ones
    });

    it('maps an unknown reason to the unknown failure label', () => {
      expect(getLabelNamesFromReasons(['[internal] Unexpected engine error'])).to.deep.equal([LABELS.UNKNOWN_FAILURE.name]);
    });
  });

  describe('#generateDescription', () => {
    const buildReporter = () => new Reporter({ type: 'github', repositories: REPOSITORIES });

    it('mentions the date of the latest tracking status change', () => {
      const description = buildReporter().generateDescription(buildResult());

      expect(description).to.include('6 April 2026');
      expect(description).to.include('10:30:00');
    });

    it('suggests the date of the latest tracking status change as validUntil', () => {
      expect(buildReporter().generateDescription(buildResult())).to.include('`2026-04-06T10:30:00Z`');
    });

    it('lists the reasons of the failure', () => {
      expect(buildReporter().generateDescription(buildResult({ reasons: [ '[fetch] HTTP code 404', '[extraction] Nothing to extract' ] }))).to.include('- [fetch] HTTP code 404\n- [extraction] Nothing to extract');
    });

    it('lists the locations of the source documents to check', () => {
      expect(buildReporter().generateDescription(buildResult({ sourceCount: 2 }))).to.include('- [ ] [https://example.com/source-0](https://example.com/source-0)\n- [ ] [https://example.com/source-1](https://example.com/source-1)');
    });

    context('when the source documents have been recorded as snapshots', () => {
      it('mentions that the missed versions might be recovered', () => {
        expect(buildReporter().generateDescription(buildResult())).to.include('might still be possible to recover');
      });
    });

    context('when the source documents could not be recorded as snapshots', () => {
      const description = buildReporter().generateDescription(buildResult({ hasSnapshots: false }));

      it('does not suggest that the missed versions might be recovered', () => {
        expect(description).to.not.include('might still be possible to recover');
      });

      it('omits the snapshot link, which would point to a nonexistent file', () => {
        expect(description).to.not.include('Latest snapshot');
        expect(description).to.not.include('.null');
      });
    });

    context('when a source document of combined terms has never been recorded as a snapshot', () => {
      it('omits its snapshot link and keeps the ones of the recorded documents', () => {
        const description = buildReporter().generateDescription(buildResult({ sourceCount: 3, withoutSnapshotIndexes: [1] }));

        expect(description).to.include('[source-0]');
        expect(description).to.not.include('[source-1]');
        expect(description).to.include('[source-2]');
        expect(description).to.not.include('.null');
      });
    });

    context('when the terms has a single source document', () => {
      it('deep-links to the contribution tool with the declaration rebuilt from the tracking result as the edit target', () => {
        const description = buildReporter().generateDescription(buildResult());
        const [ , contributionToolQuery ] = description.match(/\(https:\/\/contribute\.opentermsarchive\.org\/en\/service\?([^)]+)\)/);
        const params = new URLSearchParams(contributionToolQuery);

        expect(JSON.parse(params.get('json'))).to.deep.equal({
          name: 'Test Service',
          terms: { 'Terms of Service': { fetch: 'https://example.com/source-0', select: 'body', executeClientScripts: false } },
        });
        expect(params.get('destination')).to.equal(REPOSITORIES.declarations);
      });
    });

    context('when the terms has multiple source documents (combine)', () => {
      it('does not deep-link to the contribution tool because it cannot edit multi-source declarations', () => {
        expect(buildReporter().generateDescription(buildResult({ sourceCount: 5 }))).to.not.include('contribute.opentermsarchive.org');
      });

      it('links to the declaration file on GitHub as the edit target', () => {
        expect(buildReporter().generateDescription(buildResult({ sourceCount: 5 }))).to.include('github.com/OpenTermsArchive/test-declarations/blob/main/declarations/TestService.json');
      });

      it('keeps the description below the GitHub 65,536-character issue body limit even with many sources', () => {
        expect(buildReporter().generateDescription(buildResult({ sourceCount: 50 })).length).to.be.below(65536);
      });
    });

    context('references links', () => {
      it('links the latest version into the versions repository', () => {
        expect(buildReporter().generateDescription(buildResult())).to.include('github.com/OpenTermsArchive/test-versions/blob/main/TestService/Terms%20of%20Service.md');
      });

      it('links the latest snapshots into the snapshots repository', () => {
        const description = buildReporter().generateDescription(buildResult());

        expect(description).to.include('github.com/OpenTermsArchive/test-snapshots/blob/main/TestService/Terms%20of%20Service');
        expect(description).to.not.include('test-declarations/blob/main/TestService/Terms%20of%20Service'); // A version or snapshot link into the declarations repository is the regression this guards against
      });

      it('links to the files named after the service ID rather than after its name', () => {
        const description = buildReporter().generateDescription(buildResult());

        expect(description).to.not.include('declarations/Test%20Service.json');
        expect(description).to.not.include('Test%20Service/Terms%20of%20Service');
      });

      context('when only the declarations repository is configured', () => {
        it('omits the version and snapshots links instead of generating broken ones', () => {
          const reporter = new Reporter({ type: 'github', repositories: { declarations: 'OpenTermsArchive/test-declarations' } });

          const description = reporter.generateDescription(buildResult());

          expect(description).to.not.include('Latest version');
          expect(description).to.not.include('Latest snapshot');
          expect(description).to.not.include('undefined');
        });
      });
    });
  });

  describe('#sync', () => {
    let reporter;
    let forge;

    beforeEach(() => {
      reporter = new Reporter({ type: 'github', repositories: REPOSITORIES });
      ({ forge } = reporter);
      sinon.stub(forge, 'loadIssues').resolves();
      sinon.stub(forge, 'createOrUpdateIssue').resolves();
      sinon.stub(forge, 'closeIssueWithCommentIfExists').resolves();
    });

    it('reloads the issues before reporting', async () => {
      await reporter.sync({ run: RUN, results: [buildResult()] });

      expect(forge.loadIssues).to.have.been.calledOnce;
      expect(forge.loadIssues).to.have.been.calledBefore(forge.createOrUpdateIssue);
    });

    context('with the failed tracking result of declared terms', () => {
      beforeEach(() => reporter.sync({ run: RUN, results: [buildResult()] }));

      it('creates or updates the issue of the terms', () => {
        expect(forge.createOrUpdateIssue).to.have.been.calledOnce;
      });

      it('identifies the issue by its title', () => {
        expect(forge.createOrUpdateIssue.firstCall.args[0].title).to.equal('`TestService` ‧ `Terms of Service` ‧ not tracked anymore');
      });

      it('labels the issue after the failure reasons', () => {
        expect(forge.createOrUpdateIssue.firstCall.args[0].labels).to.deep.equal([ LABELS.DOCUMENT_NOT_FOUND.name, LABELS.NEEDS_INTERVENTION.name ]);
      });

      it('describes the failure', () => {
        expect(forge.createOrUpdateIssue.firstCall.args[0].description).to.include('No version of the `Terms of Service` of service `Test Service` is recorded anymore');
      });

      it('does not close any issue', () => {
        expect(forge.closeIssueWithCommentIfExists).to.not.have.been.called;
      });
    });

    context('with the successful tracking result of declared terms', () => {
      beforeEach(() => reporter.sync({ run: RUN, results: [buildResult({ status: STATUSES.ok })] }));

      it('closes the issue of the terms if it exists', () => {
        expect(forge.closeIssueWithCommentIfExists).to.have.been.calledOnce;
        expect(forge.closeIssueWithCommentIfExists.firstCall.args[0].title).to.equal('`TestService` ‧ `Terms of Service` ‧ not tracked anymore');
      });

      it('mentions that tracking resumed', () => {
        expect(forge.closeIssueWithCommentIfExists.firstCall.args[0].comment).to.include('Tracking resumed');
      });

      it('does not create any issue', () => {
        expect(forge.createOrUpdateIssue).to.not.have.been.called;
      });
    });

    context('with the tracking result of terms that are no longer declared', () => {
      context('when the declared terms have tracking results', () => {
        beforeEach(() => reporter.sync({ run: RUN, results: [ buildResult({ serviceId: 'Removed', declared: false }), ...Array.from({ length: 4 }, (_, index) => buildResult({ serviceId: `Declared ${index}`, status: STATUSES.ok })) ] }));

        it('closes the issue of the undeclared terms if it exists', () => {
          expect(forge.closeIssueWithCommentIfExists.firstCall.args[0].title).to.equal('`Removed` ‧ `Terms of Service` ‧ not tracked anymore');
          expect(forge.closeIssueWithCommentIfExists.firstCall.args[0].comment).to.include('no longer declared');
        });
      });

      context('when too many declared terms have no tracking result', () => {
        beforeEach(() => reporter.sync({ run: { ...RUN, declarations: { terms: 100 } }, results: [ buildResult({ serviceId: 'Removed', declared: false }), buildResult({ serviceId: 'Declared', status: STATUSES.ok }) ] }));

        it('leaves the issue of the undeclared terms untouched', () => {
          expect(forge.closeIssueWithCommentIfExists).to.have.been.calledOnce;
          expect(forge.closeIssueWithCommentIfExists.firstCall.args[0].title).to.equal('`Declared` ‧ `Terms of Service` ‧ not tracked anymore');
        });
      });
    });

    context('when an issue cannot be reported', () => {
      let syncPromise;

      beforeEach(() => {
        forge.createOrUpdateIssue.onFirstCall().rejects(new Error('GitHub is down'));
        syncPromise = reporter.sync({ run: RUN, results: [ buildResult({ serviceId: 'First' }), buildResult({ serviceId: 'Second' }) ] });
      });

      it('rejects with the number of tracking results that could not be reported', async () => {
        await expect(syncPromise).to.be.rejectedWith('1 of 2 tracking results could not be reported');
      });

      it('still reports the other tracking results', async () => {
        await syncPromise.catch(() => {});

        expect(forge.createOrUpdateIssue).to.have.been.calledTwice;
      });
    });
  });
});
