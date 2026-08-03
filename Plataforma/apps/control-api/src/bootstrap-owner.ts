import { hashPassword } from '@voidfall/authentication';
import { PostgresDatabase, createRepositories, runMigrations } from '@voidfall/database';
import { readControlApiConfig } from './config.js';

const email = process.env['VOIDFALL_BOOTSTRAP_OWNER_EMAIL'];
const password = process.env['VOIDFALL_BOOTSTRAP_OWNER_PASSWORD'];
const displayName = process.env['VOIDFALL_BOOTSTRAP_OWNER_NAME'] ?? 'VoidFall Owner';

if (email === undefined || password === undefined) {
  throw new Error('VOIDFALL_BOOTSTRAP_OWNER_EMAIL and VOIDFALL_BOOTSTRAP_OWNER_PASSWORD are required.');
}

const database = new PostgresDatabase(readControlApiConfig().databaseUrl);
try {
  await runMigrations(database);
  const repositories = createRepositories(database);
  if ((await repositories.users.findByEmail(email)) !== undefined) {
    throw new Error('A panel user already exists with that email.');
  }
  const user = await repositories.users.create({
    email,
    displayName,
    passwordHash: await hashPassword(password),
    roles: ['owner'],
  });
  process.stdout.write(`VoidFall owner created: ${user.id}\n`);
} finally {
  await database.close();
}
