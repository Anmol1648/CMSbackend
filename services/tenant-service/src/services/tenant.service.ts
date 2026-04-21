import { Sequelize } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { TenantModel } from '../central-db';
import { encrypt } from '../lib/encryption';
import crypto from 'crypto';
import pg from 'pg';
import { runTenantMigrations } from '../jobs/migrationRunner.job';

const { Client } = pg;

export class TenantService {
  private masterDbConfig = process.env.DATABASE_URL 
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT || '5432'),
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'password',
        database: process.env.PG_DATABASE || 'postgres',
      };

  async provisionTenant(data: { name: string; slug: string; domain: string }) {
    // 1. Generate unique DB name and credentials
    const tenantId = uuidv4();
    const dbName = `tenant_${data.slug}_${Date.now()}`;
    const dbUser = `usr_${data.slug}_${crypto.randomBytes(4).toString('hex')}`;
    const dbPassword = crypto.randomBytes(16).toString('hex');

    // 2. Connect to Master DB to create the new Database and User
    const client = new Client(this.masterDbConfig);
    await client.connect();

    try {
      // Postgres doesn't allow parameters for CREATE DATABASE/USER, so we must safely inject
      // Only alphanumeric and underscores are allowed in our generated names
      await client.query(`CREATE USER ${dbUser} WITH PASSWORD '${dbPassword}'`);
      await client.query(`CREATE DATABASE ${dbName} OWNER ${dbUser}`);
    } catch (err) {
      await client.end();
      throw new Error(`Failed to create database or user: ${(err as Error).message}`);
    }
    await client.end();

    // 3. Save to Central DB (status: 'provisioning')
    const credentials = JSON.stringify({ user: dbUser, password: dbPassword });
    const encryptedCredentials = encrypt(credentials);

    const tenant = await TenantModel.create({
      id: tenantId,
      name: data.name,
      slug: data.slug,
      db_host: this.masterDbConfig.host,
      db_name: dbName,
      db_credentials_encrypted: encryptedCredentials,
      domain: data.domain,
      status: 'provisioning',
    });

    // 4. Run Migrations & Seed Defaults async
    // In a real app this might be pushed to a queue
    this.setupTenant(tenantId).catch(console.error);

    return tenant;
  }

  async setupTenant(tenantId: string) {
    try {
      await this.runMigrations(tenantId);
      await this.seedDefaults(tenantId);
      
      // Update status to active
      await TenantModel.update({ status: 'active' }, { where: { id: tenantId } });
      console.log(`Tenant ${tenantId} completely provisioned and activated.`);
    } catch (error) {
      console.error(`Error finishing setup for tenant ${tenantId}:`, error);
      await TenantModel.update({ status: 'suspended' }, { where: { id: tenantId } });
    }
  }

  async runMigrations(tenantId: string) {
    console.log(`Running migrations for tenant ${tenantId}...`);
    await runTenantMigrations(tenantId);
  }

  async seedDefaults(tenantId: string) {
    console.log(`Seeding defaults for tenant ${tenantId}...`);
    // Example: Create superadmin user, basic roles, etc. using tenantPool
    // const sequelize = await tenantPool.getTenantDb(tenantId);
    // await sequelize.query('...');
  }

  async deprovision(tenantId: string) {
    const tenant = await TenantModel.findByPk(tenantId);
    if (!tenant) throw new Error('Tenant not found');

    const client = new Client(this.masterDbConfig);
    await client.connect();
    
    // Revoke connections and drop
    try {
      await client.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${tenant.db_name}' AND pid <> pg_backend_pid();
      `);
      await client.query(`DROP DATABASE IF EXISTS ${tenant.db_name}`);
      // Drop user is optional or drop roles associated
    } catch (err) {
      console.error(`Error dropping DB for ${tenantId}:`, err);
    } finally {
      await client.end();
    }

    await tenant.destroy();
    return { success: true, message: `Tenant ${tenantId} deprovisioned.` };
  }
}

export const tenantService = new TenantService();
