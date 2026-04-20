import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function seedRBAC() {
    console.log('🌱 Starting RBAC Seed...');

    // 1. Create Permissions
    const resources = ['student', 'course', 'user', 'role'];
    const actions = ['create', 'read', 'update', 'delete'];
    const customPermissions = [
        { resource: 'user', action: 'assign-role' }
    ];

    const permissionRecords = [];
    for (const res of resources) {
        for (const act of actions) {
            permissionRecords.push({ resource: res, action: act });
        }
    }
    permissionRecords.push(...customPermissions);

    console.log(`Creating ${permissionRecords.length} permissions...`);
    for (const p of permissionRecords) {
        await db.permission.upsert({
            where: { resource_action: { resource: p.resource, action: p.action } },
            update: {},
            create: p
        });
    }

    const allPerms = await db.permission.findMany();
    const permMap = new Map(allPerms.map(p => [`${p.resource}:${p.action}`, p.id]));

    // 2. Create System Roles (using 'system' tenant id)
    const TENANT_ID = 'system';
    const roles = [
        { name: 'Super Admin', slug: 'super-admin', scope: 'global', is_system: true },
        { name: 'College Admin', slug: 'college-admin', scope: 'tenant', is_system: true },
        { name: 'Faculty', slug: 'faculty', scope: 'department', is_system: true },
        { name: 'Student', slug: 'student', scope: 'self', is_system: true }
    ];

    console.log(`Creating ${roles.length} system roles...`);
    for (const r of roles) {
        await db.role.upsert({
            where: { slug_tenant_id: { slug: r.slug, tenant_id: TENANT_ID } },
            update: {},
            create: { ...r, tenant_id: TENANT_ID }
        });
    }

    const savedRoles = await db.role.findMany({ where: { tenant_id: TENANT_ID } });
    const superAdmin = savedRoles.find(r => r.slug === 'super-admin')!;
    const collegeAdmin = savedRoles.find(r => r.slug === 'college-admin')!;
    const faculty = savedRoles.find(r => r.slug === 'faculty')!;
    const student = savedRoles.find(r => r.slug === 'student')!;

    // 3. Map Permissions to Roles
    console.log('Mapping permissions to roles...');

    const rolePerms: any[] = [];
    
    // Super Admin: All permissions
    allPerms.forEach(p => {
        rolePerms.push({ role_id: superAdmin.id, permission_id: p.id });
    });

    // College Admin: All except role management
    allPerms.filter(p => p.resource !== 'role').forEach(p => {
        rolePerms.push({ role_id: collegeAdmin.id, permission_id: p.id });
    });

    // Faculty: Read students, read/update courses (own_department)
    const facultyCond = { own_department: true };
    rolePerms.push({ role_id: faculty.id, permission_id: permMap.get('student:read')!, condition: facultyCond });
    rolePerms.push({ role_id: faculty.id, permission_id: permMap.get('course:read')!, condition: facultyCond });
    rolePerms.push({ role_id: faculty.id, permission_id: permMap.get('course:update')!, condition: facultyCond });

    // Student: Read own profile
    const studentCond = { own_data: true };
    rolePerms.push({ role_id: student.id, permission_id: permMap.get('student:read')!, condition: studentCond });
    rolePerms.push({ role_id: student.id, permission_id: permMap.get('user:read')!, condition: studentCond });

    console.log(`Upserting ${rolePerms.length} role-permission mappings...`);
    for (const rp of rolePerms) {
        await db.rolePermission.upsert({
            where: { role_id_permission_id: { role_id: rp.role_id, permission_id: rp.permission_id } },
            update: { condition: rp.condition || null },
            create: rp
        });
    }

    console.log('✅ RBAC Seed Complete!');
}

seedRBAC()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await db.$disconnect();
    });
