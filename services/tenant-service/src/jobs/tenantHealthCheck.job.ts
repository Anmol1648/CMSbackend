import { TenantModel } from '../central-db';
import { tenantPool } from '../lib/tenantPool';

export function startTenantHealthCheck() {
  setInterval(async () => {
    try {
      const activeTenants = await TenantModel.findAll({ where: { status: 'active' } });
      
      for (const tenant of activeTenants) {
        try {
          const sequelize = await tenantPool.getTenantDb(tenant.id);
          await sequelize.query('SELECT 1');
          // console.log(`Health check passed for tenant ${tenant.id}`);
        } catch (err) {
          console.error(`Health check failed for tenant ${tenant.id}:`, err);
          // Optional: mark as suspended if failing multiple times
        }
      }
    } catch (err) {
      console.error('Error fetching tenants for health check:', err);
    }
  }, 60000); // 60 seconds
}
