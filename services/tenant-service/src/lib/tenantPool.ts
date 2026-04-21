import { Sequelize } from 'sequelize';
import { LRUCache } from 'lru-cache';
import { TenantModel } from '../central-db';
import { decrypt } from './encryption';

class TenantPool {
  private pool: LRUCache<string, Sequelize>;

  constructor() {
    this.pool = new LRUCache<string, Sequelize>({
      max: 500,
      dispose: (client: Sequelize, key: string) => {
        // Close connection when evicted
        client.close().catch(console.error);
        console.log(`Tenant DB connection evicted for: ${key}`);
      },
    });
  }

  async getTenantDb(tenantId: string): Promise<Sequelize> {
    const cached = this.pool.get(tenantId);
    if (cached) {
      return cached;
    }

    const tenant = await TenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    if (tenant.status !== 'active') {
      throw new Error(`Tenant is not active: ${tenantId} (status: ${tenant.status})`);
    }

    const credentials = JSON.parse(decrypt(tenant.db_credentials_encrypted));
    
    const sequelize = new Sequelize(
      tenant.db_name,
      credentials.user,
      credentials.password,
      {
        host: tenant.db_host,
        dialect: 'postgres',
        logging: false,
        pool: {
          max: 10,
          min: 0,
          acquire: 30000,
          idle: 10000
        }
      }
    );

    await sequelize.authenticate();
    this.pool.set(tenantId, sequelize);
    return sequelize;
  }
  
  clearPool() {
    this.pool.clear();
  }
}

export const tenantPool = new TenantPool();
