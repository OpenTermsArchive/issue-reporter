import { use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import sinonChai from 'sinon-chai';

use(chaiAsPromised);
use(sinonChai);

nock.disableNetConnect(); // Every exchange with the forges and the Collection API is mocked, so a request reaching the network is a test error

process.env.OTA_ISSUE_REPORTER_GITHUB_TOKEN ??= 'github-token'; // The reporter refuses to start without the token of its forge
process.env.OTA_ISSUE_REPORTER_GITLAB_TOKEN ??= 'gitlab-token';
