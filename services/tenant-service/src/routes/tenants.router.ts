import { Router } from 'express';
import { TenantModel } from '../central-db';
import { tenantService } from '../services/tenant.service';
import { tenantPool } from '../lib/tenantPool';

const router = Router();

// Middleware placeholder for Super Admin check
const requireSuperAdmin = (req: any, res: any, next: any) => {
  // In a real implementation this would check JWT roles
  next();
};

router.use(requireSuperAdmin);

// GET /api/tenants — list all
router.get('/', async (req, res) => {
  try {
    const tenants = await TenantModel.findAll({
      attributes: { exclude: ['db_credentials_encrypted'] }
    });
    res.json({ success: true, data: tenants });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/tenants — onboard new college
router.post('/', async (req, res) => {
  try {
    const { name, slug, domain } = req.body;
    if (!name || !slug || !domain) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    const tenant = await tenantService.provisionTenant({ name, slug, domain });
    const { db_credentials_encrypted, ...tenantSafe } = tenant.toJSON();
    
    res.status(201).json({ success: true, data: tenantSafe });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/tenants/:id — detail + health status
router.get('/:id', async (req, res) => {
  try {
    const tenant = await TenantModel.findByPk(req.params.id, {
      attributes: { exclude: ['db_credentials_encrypted'] }
    });
    
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    
    let isHealthy = false;
    if (tenant.status === 'active') {
      try {
        const sequelize = await tenantPool.getTenantDb(tenant.id);
        await sequelize.query('SELECT 1');
        isHealthy = true;
      } catch (err) {
         isHealthy = false;
      }
    }

    res.json({ success: true, data: { ...tenant.toJSON(), isHealthy } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/tenants/:id/migrate — trigger migration run
router.post('/:id/migrate', async (req, res) => {
  try {
    const tenant = await TenantModel.findByPk(req.params.id);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    if (tenant.status !== 'active') return res.status(400).json({ success: false, message: 'Tenant must be active' });
    
    await tenantService.runMigrations(tenant.id);
    res.json({ success: true, message: 'Migrations successfully triggered' });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /api/tenants/:id/status — activate/suspend
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const tenant = await TenantModel.findByPk(req.params.id);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

    tenant.status = status;
    await tenant.save();

    if (status === 'suspended') {
      // Evict from pool on suspend
      const cached = (tenantPool as any).pool.get(tenant.id);
      if (cached) {
         cached.close();
         (tenantPool as any).pool.delete(tenant.id);
      }
    }

    res.json({ success: true, data: { id: tenant.id, status: tenant.status } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export const tenantRouter = router;
