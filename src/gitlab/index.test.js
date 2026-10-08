import { expect } from 'chai';
import nock from 'nock';

import { LABELS, MANAGED_BY_OTA_MARKER } from '../labels.js';

import GitLab from './index.js';

describe('GitLab', function () {
  this.timeout(5000);

  let MANAGED_LABELS;
  let gitlab;
  const PROJECT_ID = 4;
  const REPOSITORIES = { declarations: 'owner/repo', versions: 'owner/versions-repo', snapshots: 'owner/snapshots-repo' };
  const ISSUES_QUERY = { scope: 'all', state: GitLab.ISSUE_STATE_ALL, per_page: '100', page: '1' };
  const EXISTING_OPEN_ISSUE = { iid: 1, title: 'Opened issue', description: 'Issue description', state: GitLab.ISSUE_STATE_OPEN, labels: [LABELS.HTTP_403.name], created_at: '2024-01-01T00:00:00Z', web_url: 'https://gitlab.com/owner/repo/-/issues/1' };
  const EXISTING_CLOSED_ISSUE = { iid: 2, title: 'Closed issue', description: 'Issue description', state: GitLab.ISSUE_STATE_CLOSED, labels: [LABELS.EMPTY_CONTENT.name], created_at: '2024-01-02T00:00:00Z', web_url: 'https://gitlab.com/owner/repo/-/issues/2' };
  const asGitLabLabel = label => ({ ...label, color: `#${label.color}`, description: `${label.description} ${MANAGED_BY_OTA_MARKER}` }); // GitLab lists label colors with a leading hash and the managed labels carry the marker in their description

  function mockIssuesListing(issues = [ EXISTING_OPEN_ISSUE, EXISTING_CLOSED_ISSUE ]) {
    return nock(gitlab.apiBaseURL)
      .get(`/projects/${PROJECT_ID}/issues`)
      .query(ISSUES_QUERY)
      .reply(200, issues);
  }

  before(async () => {
    MANAGED_LABELS = Object.values(LABELS);
    gitlab = new GitLab(REPOSITORIES);
    gitlab.projectId = PROJECT_ID;
    mockIssuesListing();
    await gitlab.loadIssues();
  });

  describe('#initialize', () => {
    context('when some labels are missing', () => {
      const scopes = [];

      before(async () => {
        const existingLabels = MANAGED_LABELS.slice(0, -2).map(asGitLabLabel);

        nock(gitlab.apiBaseURL)
          .get(`/projects/${encodeURIComponent('owner/repo')}`)
          .reply(200, { id: PROJECT_ID });

        nock(gitlab.apiBaseURL)
          .get(`/projects/${PROJECT_ID}/labels?with_counts=true`)
          .reply(200, existingLabels);

        const missingLabels = MANAGED_LABELS.slice(-2);

        for (const label of missingLabels) {
          scopes.push(nock(gitlab.apiBaseURL)
            .post(`/projects/${PROJECT_ID}/labels`, body => body.name === label.name)
            .reply(200, { name: label.name }));
        }

        await gitlab.initialize();
      });

      after(nock.cleanAll);

      it('resolves the project ID', () => {
        expect(gitlab.projectId).to.equal(PROJECT_ID);
      });

      it('should create missing labels', () => {
        scopes.forEach(scope => expect(scope.isDone()).to.be.true);
      });
    });

    context('when some labels are obsolete', () => {
      const deleteScopes = [];

      before(async () => {
        const existingLabels = [
          ...MANAGED_LABELS.map(asGitLabLabel),
          // Add an obsolete label that should be removed
          {
            name: 'obsolete label',
            color: '#FF0000',
            description: `This label is no longer used ${MANAGED_BY_OTA_MARKER}`,
          },
        ];

        nock(gitlab.apiBaseURL)
          .get(`/projects/${encodeURIComponent('owner/repo')}`)
          .reply(200, { id: PROJECT_ID });

        nock(gitlab.apiBaseURL)
          .get(`/projects/${PROJECT_ID}/labels?with_counts=true`)
          .reply(200, existingLabels);

        // Mock the delete call for the obsolete label
        deleteScopes.push(nock(gitlab.apiBaseURL)
          .delete(`/projects/${PROJECT_ID}/labels/${encodeURIComponent('obsolete label')}`)
          .reply(204));

        // Mock the second getRepositoryLabels call after deletion
        nock(gitlab.apiBaseURL)
          .get(`/projects/${PROJECT_ID}/labels?with_counts=true`)
          .reply(200, MANAGED_LABELS.map(asGitLabLabel));

        await gitlab.initialize();
      });

      after(nock.cleanAll);

      it('should remove obsolete managed labels', () => {
        deleteScopes.forEach(scope => expect(scope.isDone()).to.be.true);
      });
    });

    context('when some labels have changed descriptions', () => {
      const updateScopes = [];

      before(async () => {
        const originalTestLabels = MANAGED_LABELS.slice(-2);
        const testLabels = originalTestLabels.map(label => ({
          ...label,
          description: `${label.description} - obsolete description`,
        }));

        nock(gitlab.apiBaseURL)
          .get(`/projects/${encodeURIComponent('owner/repo')}`)
          .reply(200, { id: PROJECT_ID });

        nock(gitlab.apiBaseURL)
          .persist()
          .get(`/projects/${PROJECT_ID}/labels?with_counts=true`)
          .reply(200, [
            ...MANAGED_LABELS.slice(0, -2).map(asGitLabLabel),
            ...testLabels.map(asGitLabLabel),
          ]);

        for (const label of originalTestLabels) {
          updateScopes.push(nock(gitlab.apiBaseURL)
            .put(`/projects/${PROJECT_ID}/labels/${encodeURIComponent(label.name)}`, body =>
              body.description === `${label.description} ${MANAGED_BY_OTA_MARKER}`)
            .reply(200, { name: label.name, color: `#${label.color}` }));
        }

        await gitlab.initialize();
      });

      after(() => {
        nock.cleanAll();
      });

      it('should update labels with changed descriptions', () => {
        updateScopes.forEach(scope => expect(scope.isDone()).to.be.true);
      });
    });

    context('when the project cannot be resolved', () => {
      before(() => {
        nock(gitlab.apiBaseURL)
          .get(`/projects/${encodeURIComponent('owner/repo')}`)
          .reply(404, { message: '404 Project Not Found' });
      });

      after(nock.cleanAll);

      it('rejects rather than carrying on without a project', async () => {
        await expect(gitlab.initialize()).to.be.rejectedWith('status 404');
      });
    });

    context('when the token is rejected', () => {
      before(() => {
        nock(gitlab.apiBaseURL)
          .get(`/projects/${encodeURIComponent('owner/repo')}`)
          .reply(200, { id: PROJECT_ID });

        nock(gitlab.apiBaseURL)
          .get(`/projects/${PROJECT_ID}/labels?with_counts=true`)
          .reply(401, { message: '401 Unauthorized' });
      });

      after(nock.cleanAll);

      it('rejects rather than failing at every synchronization', async () => {
        await expect(gitlab.initialize()).to.be.rejectedWith('status 401');
      });
    });
  });

  describe('#loadIssues', () => {
    const OLDER_DUPLICATE = { iid: 3, title: 'Duplicated issue', state: GitLab.ISSUE_STATE_OPEN, labels: [], created_at: '2023-01-01T00:00:00Z' };
    const NEWER_DUPLICATE = { iid: 4, title: 'Duplicated issue', state: GitLab.ISSUE_STATE_OPEN, labels: [], created_at: '2023-06-01T00:00:00Z' };
    const SECOND_PAGE_ISSUE = { iid: 5, title: 'Issue on the second page', state: GitLab.ISSUE_STATE_OPEN, labels: [], created_at: '2023-06-01T00:00:00Z' };
    let issues;

    before(async () => {
      nock(gitlab.apiBaseURL)
        .get(`/projects/${PROJECT_ID}/issues`)
        .query(ISSUES_QUERY)
        .reply(200, [ NEWER_DUPLICATE, OLDER_DUPLICATE ], { 'x-next-page': '2' });

      nock(gitlab.apiBaseURL)
        .get(`/projects/${PROJECT_ID}/issues`)
        .query({ ...ISSUES_QUERY, page: '2' })
        .reply(200, [SECOND_PAGE_ISSUE], { 'x-next-page': '' });

      issues = await gitlab.loadIssues();
    });

    after(async () => {
      nock.cleanAll();
      mockIssuesListing();
      await gitlab.loadIssues();
    });

    it('drops the issues loaded before', () => {
      expect(issues.has(EXISTING_OPEN_ISSUE.title)).to.be.false;
    });

    it('keeps the oldest of the issues sharing a title', () => {
      expect(issues.get(OLDER_DUPLICATE.title)).to.deep.equal(OLDER_DUPLICATE);
    });

    it('loads every page', () => {
      expect(issues.get(SECOND_PAGE_ISSUE.title)).to.deep.equal(SECOND_PAGE_ISSUE);
    });
  });

  describe('#getRepositoryLabels', () => {
    let scope;
    let result;
    const LABELS = [{ name: 'bug' }, { name: 'enhancement' }];

    before(async () => {
      scope = nock(gitlab.apiBaseURL)
        .get(`/projects/${PROJECT_ID}/labels?with_counts=true`)
        .reply(200, LABELS);

      result = await gitlab.getRepositoryLabels();
    });

    after(nock.cleanAll);

    it('fetches repository labels', () => {
      expect(scope.isDone()).to.be.true;
    });

    it('returns the repository labels', () => {
      expect(result).to.deep.equal(LABELS);
    });

    it('rejects when GitLab fails', async () => {
      nock(gitlab.apiBaseURL)
        .get(`/projects/${PROJECT_ID}/labels?with_counts=true`)
        .reply(500, { message: 'Internal Server Error' });

      await expect(gitlab.getRepositoryLabels()).to.be.rejectedWith('status 500');
    });

    it('rejects with the status when GitLab answers with a non-JSON body', async () => {
      nock(gitlab.apiBaseURL)
        .get(`/projects/${PROJECT_ID}/labels?with_counts=true`)
        .reply(502, '<html><body>Bad Gateway</body></html>');

      await expect(gitlab.getRepositoryLabels()).to.be.rejectedWith('status 502');
    });
  });

  describe('#createLabel', () => {
    let scope;
    const LABEL = { name: 'new_label', color: 'ffffff' };

    before(async () => {
      scope = nock(gitlab.apiBaseURL)
        .post(`/projects/${PROJECT_ID}/labels`, body => body.name === LABEL.name)
        .reply(200, LABEL);

      await gitlab.createLabel(LABEL);
    });

    after(nock.cleanAll);

    it('creates the new label', () => {
      expect(scope.isDone()).to.be.true;
    });
  });

  describe('#createIssue', () => {
    let scope;
    let result;

    const ISSUE = {
      title: 'New Issue',
      description: 'Description of the new issue',
      labels: ['bug'],
    };
    const CREATED_ISSUE = {
      title: 'New Issue',
      description: 'Description of the new issue',
      labels: ['bug'],
      iid: 555,
      web_url: 'https://example.com/test/test',
    };

    before(async () => {
      scope = nock(gitlab.apiBaseURL)
        .post(`/projects/${PROJECT_ID}/issues`, ISSUE)
        .reply(200, CREATED_ISSUE);

      result = await gitlab.createIssue(ISSUE);
    });

    after(() => {
      nock.cleanAll();
      gitlab.issuesCache.delete(ISSUE.title);
    });

    it('creates the new issue', () => {
      expect(scope.isDone()).to.be.true;
    });

    it('returns the created issue', () => {
      expect(result).to.deep.equal(CREATED_ISSUE);
    });
  });

  describe('#updateIssue', () => {
    const ISSUE = { iid: 123, title: 'Issue to update' };

    afterEach(() => {
      nock.cleanAll();
      gitlab.issuesCache.delete(ISSUE.title);
    });

    it('sets the labels of the issue', async () => {
      const labels = [ 'bug', 'enhancement' ];
      const scope = nock(gitlab.apiBaseURL)
        .put(`/projects/${PROJECT_ID}/issues/${ISSUE.iid}`, { labels })
        .reply(200, { ...ISSUE, labels });

      await gitlab.updateIssue(ISSUE, { labels });

      expect(scope.isDone()).to.be.true;
    });

    it('changes the state of the issue through a state event', async () => {
      const scope = nock(gitlab.apiBaseURL)
        .put(`/projects/${PROJECT_ID}/issues/${ISSUE.iid}`, { state_event: 'close' })
        .reply(200, { ...ISSUE, state: GitLab.ISSUE_STATE_CLOSED });

      await gitlab.updateIssue(ISSUE, { stateEvent: 'close' });

      expect(scope.isDone()).to.be.true;
    });

    it('rejects when GitLab fails', async () => {
      nock(gitlab.apiBaseURL)
        .put(`/projects/${PROJECT_ID}/issues/${ISSUE.iid}`)
        .reply(403, { message: '403 Forbidden' });

      await expect(gitlab.updateIssue(ISSUE, { stateEvent: 'close' })).to.be.rejectedWith('status 403');
    });
  });

  describe('#getIssue', () => {
    context('when the issue exists in the cache', () => {
      it('returns the cached issue', async () => {
        expect(await gitlab.getIssue(EXISTING_OPEN_ISSUE.title)).to.deep.equal(EXISTING_OPEN_ISSUE);
      });
    });

    context('when the issue does not exist in the cache', () => {
      it('returns undefined', async () => {
        expect(await gitlab.getIssue('Non-existent Issue')).to.be.undefined;
      });
    });
  });

  describe('#addCommentToIssue', () => {
    let scope;
    const ISSUE = { iid: 123, title: 'Test Issue' };
    const COMMENT = 'Test comment';
    const response = { iid: 123, id: 23, body: 'Test comment' };

    before(async () => {
      scope = nock(gitlab.apiBaseURL)
        .post(`/projects/${PROJECT_ID}/issues/${ISSUE.iid}/notes`, { body: COMMENT })
        .reply(200, response);

      await gitlab.addCommentToIssue({ issue: ISSUE, comment: COMMENT });
    });

    after(nock.cleanAll);

    it('adds the comment to the issue', () => {
      expect(scope.isDone()).to.be.true;
    });
  });

  describe('#closeIssueWithCommentIfExists', () => {
    const COMMENT = 'Closing comment';

    after(nock.cleanAll);

    context('when the issue exists and is open', () => {
      let addCommentScope;
      let closeIssueScope;

      before(async () => {
        addCommentScope = nock(gitlab.apiBaseURL)
          .post(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}/notes`, { body: COMMENT })
          .reply(200, { iid: EXISTING_OPEN_ISSUE.iid, id: 23, body: COMMENT });

        closeIssueScope = nock(gitlab.apiBaseURL)
          .put(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}`, { state_event: 'close' })
          .reply(200, { ...EXISTING_OPEN_ISSUE, state: GitLab.ISSUE_STATE_CLOSED });

        await gitlab.closeIssueWithCommentIfExists({ title: EXISTING_OPEN_ISSUE.title, comment: COMMENT });
      });

      after(() => {
        gitlab.issuesCache.set(EXISTING_OPEN_ISSUE.title, EXISTING_OPEN_ISSUE);
      });

      it('adds comment to the issue', () => {
        expect(addCommentScope.isDone()).to.be.true;
      });

      it('closes the issue', () => {
        expect(closeIssueScope.isDone()).to.be.true;
      });
    });

    context('when the issue exists and is closed', () => {
      let addCommentScope;
      let closeIssueScope;

      before(async () => {
        addCommentScope = nock(gitlab.apiBaseURL)
          .post(`/projects/${PROJECT_ID}/issues/${EXISTING_CLOSED_ISSUE.iid}/notes`, { body: COMMENT })
          .reply(200);

        closeIssueScope = nock(gitlab.apiBaseURL)
          .put(`/projects/${PROJECT_ID}/issues/${EXISTING_CLOSED_ISSUE.iid}`, { state_event: 'close' })
          .reply(200);

        await gitlab.closeIssueWithCommentIfExists({ title: EXISTING_CLOSED_ISSUE.title, comment: COMMENT });
      });

      it('does not add comment', () => {
        expect(addCommentScope.isDone()).to.be.false;
      });

      it('does not attempt to close the issue', () => {
        expect(closeIssueScope.isDone()).to.be.false;
      });
    });

    context('when the issue does not exist', () => {
      let addCommentScope;
      let closeIssueScope;

      before(async () => {
        addCommentScope = nock(gitlab.apiBaseURL)
          .post(/\/projects\/\d+\/issues\/\d+\/notes/, { body: COMMENT })
          .reply(200);

        closeIssueScope = nock(gitlab.apiBaseURL)
          .put(/\/projects\/\d+\/issues\/\d+/, { state_event: 'close' })
          .reply(200);

        await gitlab.closeIssueWithCommentIfExists({ title: 'Non-existent Issue', comment: COMMENT });
      });

      it('does not attempt to add comment', () => {
        expect(addCommentScope.isDone()).to.be.false;
      });

      it('does not attempt to close the issue', () => {
        expect(closeIssueScope.isDone()).to.be.false;
      });
    });
  });

  describe('#createOrUpdateIssue', () => {
    context('when the issue does not exist', () => {
      let createIssueScope;
      const ISSUE_TO_CREATE = {
        title: 'New Issue',
        description: 'Description of the new issue',
        labels: [LABELS.EMPTY_RESPONSE.name],
      };

      before(async () => {
        createIssueScope = nock(gitlab.apiBaseURL)
          .post(`/projects/${PROJECT_ID}/issues`, ISSUE_TO_CREATE)
          .reply(200, { iid: 123, title: ISSUE_TO_CREATE.title, web_url: 'https://example.com/test/test' });

        await gitlab.createOrUpdateIssue(ISSUE_TO_CREATE);
      });

      after(() => {
        nock.cleanAll();
        gitlab.issuesCache.delete(ISSUE_TO_CREATE.title);
      });

      it('creates the issue', () => {
        expect(createIssueScope.isDone()).to.be.true;
      });
    });

    context('when the issue already exists', () => {
      const DESCRIPTION = 'New comment';

      afterEach(() => { // The adapter keeps the issues it updates, so each context starts from the issues as loaded
        gitlab.issuesCache.set(EXISTING_OPEN_ISSUE.title, EXISTING_OPEN_ISSUE);
        gitlab.issuesCache.set(EXISTING_CLOSED_ISSUE.title, EXISTING_CLOSED_ISSUE);
      });

      after(nock.cleanAll);

      context('when issue is closed', () => {
        let updateIssueScope;
        let addCommentScope;

        before(async () => {
          nock.cleanAll(); // Interceptors left by the previous contexts would answer instead of the ones of this context
          updateIssueScope = nock(gitlab.apiBaseURL)
            .put(`/projects/${PROJECT_ID}/issues/${EXISTING_CLOSED_ISSUE.iid}`, { state_event: 'reopen', labels: [LABELS.HTTP_403.name] })
            .reply(200, { ...EXISTING_CLOSED_ISSUE, state: GitLab.ISSUE_STATE_OPEN, labels: [LABELS.HTTP_403.name] });

          addCommentScope = nock(gitlab.apiBaseURL)
            .post(`/projects/${PROJECT_ID}/issues/${EXISTING_CLOSED_ISSUE.iid}/notes`, { body: DESCRIPTION })
            .reply(200, { iid: EXISTING_CLOSED_ISSUE.iid, id: 23, body: DESCRIPTION });

          await gitlab.createOrUpdateIssue({ title: EXISTING_CLOSED_ISSUE.title, description: DESCRIPTION, labels: [LABELS.HTTP_403.name] });
        });

        it('reopens the issue and updates its labels', () => {
          expect(updateIssueScope.isDone()).to.be.true;
        });

        it('adds comment to the issue', () => {
          expect(addCommentScope.isDone()).to.be.true;
        });
      });

      context('when issue is already opened', () => {
        context('when the reason is new', () => {
          let updateIssueScope;
          let addCommentScope;

          before(async () => {
            nock.cleanAll(); // Interceptors left by the previous contexts would answer instead of the ones of this context
            updateIssueScope = nock(gitlab.apiBaseURL)
              .put(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}`, { labels: [LABELS.EMPTY_CONTENT.name] })
              .reply(200, { ...EXISTING_OPEN_ISSUE, labels: [LABELS.EMPTY_CONTENT.name] });

            addCommentScope = nock(gitlab.apiBaseURL)
              .post(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}/notes`, { body: DESCRIPTION })
              .reply(200, { iid: EXISTING_OPEN_ISSUE.iid, id: 23, body: DESCRIPTION });

            await gitlab.createOrUpdateIssue({ title: EXISTING_OPEN_ISSUE.title, description: DESCRIPTION, labels: [LABELS.EMPTY_CONTENT.name] });
          });

          it("updates the issue's labels without changing its state", () => {
            expect(updateIssueScope.isDone()).to.be.true;
          });

          it('adds comment to the issue', () => {
            expect(addCommentScope.isDone()).to.be.true;
          });
        });

        context('when all requested labels are already present', () => {
          let updateIssueScope;
          let addCommentScope;

          before(async () => {
            nock.cleanAll(); // Interceptors left by the previous contexts would answer instead of the ones of this context
            updateIssueScope = nock(gitlab.apiBaseURL)
              .put(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}`)
              .reply(200);

            addCommentScope = nock(gitlab.apiBaseURL)
              .post(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}/notes`)
              .reply(200);

            await gitlab.createOrUpdateIssue({ title: EXISTING_OPEN_ISSUE.title, description: DESCRIPTION, labels: [LABELS.HTTP_403.name] });
          });

          it('does not attempt to update the issue labels', () => {
            expect(updateIssueScope.isDone()).to.be.false;
          });

          it('does not attempt to add any comment to the issue', () => {
            expect(addCommentScope.isDone()).to.be.false;
          });
        });

        context('when some but not all requested labels are present', () => {
          let updateIssueScope;
          let addCommentScope;

          before(async () => {
            nock.cleanAll(); // Interceptors left by the previous contexts would answer instead of the ones of this context
            updateIssueScope = nock(gitlab.apiBaseURL)
              .put(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}`, { labels: [ LABELS.HTTP_403.name, LABELS.EMPTY_CONTENT.name ] })
              .reply(200, { ...EXISTING_OPEN_ISSUE, labels: [ LABELS.HTTP_403.name, LABELS.EMPTY_CONTENT.name ] });

            addCommentScope = nock(gitlab.apiBaseURL)
              .post(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}/notes`, { body: DESCRIPTION })
              .reply(200, { iid: EXISTING_OPEN_ISSUE.iid, id: 23, body: DESCRIPTION });

            await gitlab.createOrUpdateIssue({ title: EXISTING_OPEN_ISSUE.title, description: DESCRIPTION, labels: [ LABELS.HTTP_403.name, LABELS.EMPTY_CONTENT.name ] });
          });

          it("updates the issue's labels", () => {
            expect(updateIssueScope.isDone()).to.be.true;
          });

          it('adds comment to the issue', () => {
            expect(addCommentScope.isDone()).to.be.true;
          });
        });

        context('when the issue carries labels that are not managed', () => {
          let updateIssueScope;

          before(async () => {
            nock.cleanAll();
            gitlab.issuesCache.set(EXISTING_OPEN_ISSUE.title, { ...EXISTING_OPEN_ISSUE, labels: [ 'custom label', LABELS.HTTP_403.name ] });

            updateIssueScope = nock(gitlab.apiBaseURL)
              .put(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}`, { labels: [ LABELS.EMPTY_CONTENT.name, 'custom label' ] })
              .reply(200, { ...EXISTING_OPEN_ISSUE, labels: [ LABELS.EMPTY_CONTENT.name, 'custom label' ] });

            nock(gitlab.apiBaseURL)
              .post(`/projects/${PROJECT_ID}/issues/${EXISTING_OPEN_ISSUE.iid}/notes`)
              .reply(200, { iid: EXISTING_OPEN_ISSUE.iid, id: 23, body: DESCRIPTION });

            await gitlab.createOrUpdateIssue({ title: EXISTING_OPEN_ISSUE.title, description: DESCRIPTION, labels: [LABELS.EMPTY_CONTENT.name] });
          });

          it('keeps the labels that are not managed', () => {
            expect(updateIssueScope.isDone()).to.be.true;
          });
        });
      });
    });
  });

  describe('URL generation', () => {
    it('links the declaration into the declarations repository', () => {
      expect(gitlab.generateDeclarationURL('Service A')).to.equal('https://gitlab.com/owner/repo/-/blob/main/declarations/Service%20A.json');
    });

    it('links the version into the versions repository', () => {
      expect(gitlab.generateVersionURL('Service A', 'Terms of Service')).to.equal('https://gitlab.com/owner/versions-repo/-/blob/main/Service%20A/Terms%20of%20Service.md');
    });

    it('links the snapshots into the snapshots repository', () => {
      expect(gitlab.generateSnapshotsBaseUrl('Service A', 'Terms of Service')).to.equal('https://gitlab.com/owner/snapshots-repo/-/blob/main/Service%20A/Terms%20of%20Service');
    });

    context('with a custom base URL', () => {
      it('links into the custom instance', () => {
        const customGitlab = new GitLab(REPOSITORIES, 'https://gitlab.example.test');

        expect(customGitlab.generateVersionURL('Service A', 'Terms of Service')).to.equal('https://gitlab.example.test/owner/versions-repo/-/blob/main/Service%20A/Terms%20of%20Service.md');
      });
    });
  });
});
