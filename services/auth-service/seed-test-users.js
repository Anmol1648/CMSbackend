const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  const tenant_id = 'default-tenant';

  // 1. Get existing roles
  const roles = await prisma.role.findMany({
    where: { slug: { in: ['student', 'faculty', 'college-admin', 'super-admin'] } }
  });

  const getRole = (slug) => roles.find(r => r.slug === slug);

  console.log(`Found ${roles.length} roles.`);

  // Define users to create
  const usersToCreate = [
    {
      email: 'student@example.com',
      first_name: 'John',
      last_name: 'Student',
      roleSlug: 'student'
    },
    {
      email: 'faculty@example.com',
      first_name: 'Jane',
      last_name: 'Faculty',
      roleSlug: 'faculty'
    },
    {
      email: 'admin@example.com',
      first_name: 'Admin',
      last_name: 'User',
      roleSlug: 'college-admin'
    },
    {
      email: 'super@example.com',
      first_name: 'Super',
      last_name: 'Admin',
      roleSlug: 'super-admin'
    }
  ];

  const password_hash = await bcrypt.hash('password123', 10);

  for (const u of usersToCreate) {
    const role = getRole(u.roleSlug);
    if (!role) {
      console.warn(`Role ${u.roleSlug} not found. Skipping user ${u.email}`);
      continue;
    }

    // Upsert User
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        first_name: u.first_name,
        last_name: u.last_name,
        password_hash,
        tenant_id,
        is_active: true,
        profile: {
          create: {
             phone: "1234567890"
          }
        }
      }
    });

    // Assign Role
    await prisma.userRole.upsert({
      where: {
        user_id_role_id_tenant_id: {
          user_id: user.id,
          role_id: role.id,
          tenant_id
        }
      },
      update: {},
      create: {
        user_id: user.id,
        role_id: role.id,
        tenant_id
      }
    });

    console.log(`Created/Ensured user ${u.email} with role ${u.roleSlug}`);
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
