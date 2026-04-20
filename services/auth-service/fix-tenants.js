const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fix() {
  await prisma.user.updateMany({
    where: { email: { in: ['student@example.com', 'faculty@example.com', 'admin@example.com', 'super@example.com'] } },
    data: { tenant_id: '1b7f8b7b-c970-45c1-9cf4-29f47d3dd3ed' }
  });
  
  await prisma.userRole.updateMany({
    where: { tenant_id: 'default-tenant' },
    data: { tenant_id: '1b7f8b7b-c970-45c1-9cf4-29f47d3dd3ed' }
  });
}

fix()
  .then(() => console.log('Fixed tenant IDs'))
  .finally(() => prisma.$disconnect());
