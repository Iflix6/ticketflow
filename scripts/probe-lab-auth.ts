import request from 'supertest';
import { createApp } from '../apps/api/src/app.js';
import { createLogger } from '../apps/api/src/observability/logger.js';
import { issueToken } from '../apps/api/src/modules/auth/credentials.js';
import { testConfig } from '../tests/helpers/config.js';
import { startTestDatabase } from '../tests/helpers/integration-db.js';

const handle = await startTestDatabase('probe');
const config = testConfig({ LAB_ENABLED: 'true' });
const app = createApp({ config, db: handle.db, logger: createLogger(config) });

for (const role of ['CUSTOMER', 'LAB_ADMIN'] as const) {
  const token = issueToken(
    { id: '00000000-0000-4000-8000-000000000001', email: `${role.toLowerCase()}@local.test`, role },
    config.AUTH_SECRET,
    600,
  );
  const res = await request(app).get('/api/v1/lab/strategies').set('Authorization', `Bearer ${token}`);
  console.log(role, res.status, JSON.stringify(res.body));
}

await handle.cleanup();
