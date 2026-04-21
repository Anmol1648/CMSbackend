import { Umzug, SequelizeStorage } from 'umzug';
import { tenantPool } from '../lib/tenantPool';
import { TenantModel } from '../central-db';
import path from 'path';

export async function runTenantMigrations(tenantId: string) {
  const sequelize = await tenantPool.getTenantDb(tenantId);
  const umzug = new Umzug({
    migrations: {
      glob: path.join(__dirname, '../../migrations/*.js'), // Assuming compiling to JS later
      resolve: ({ name, path: migrationPath, context }) => {
        const migration = require(migrationPath!);
        return {
          name,
          up: async () => migration.up({ context }),
          down: async () => migration.down({ context }),
        };
      },
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: console,
  });

  await umzug.up();
  console.log(`Migrations finished for tenant ${tenantId}`);
}

export async function runAllTenantsMigrations() {
  const tenants = await TenantModel.findAll({ where: { status: 'active' } });
  for (const tenant of tenants) {
    try {
      await runTenantMigrations(tenant.id);
    } catch (e) {
      console.error(`Failed migration for tenant ${tenant.id}`, e);
    }
  }
}
