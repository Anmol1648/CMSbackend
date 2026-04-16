const { execSync } = require('child_process');
const path = require('path');

const services = [
    { name: 'auth-service', path: 'services/auth-service' },
    // Add other services here as they are created
    // { name: 'rbac-service', path: 'services/rbac-service' },
];

const runMigrations = () => {
    console.log('🚀 Starting Global Migration Runner...\n');

    for (const service of services) {
        const servicePath = path.resolve(__dirname, '..', service.path);
        
        console.log(`--------------------------------------------------`);
        console.log(`📂 Service: ${service.name}`);
        console.log(`📍 Path: ${servicePath}`);
        console.log(`⏳ Running migrations...`);

        try {
            execSync('npx prisma migrate deploy', {
                cwd: servicePath,
                stdio: 'inherit',
                env: { ...process.env } // Uses DATABASE_URL from service's context/env
            });
            console.log(`✅ Migration completed for ${service.name}\n`);
        } catch (error) {
            console.error(`❌ Migration failed for ${service.name}`);
            console.error(`🛑 Stopping execution.`);
            process.exit(1);
        }
    }

    console.log('--------------------------------------------------');
    console.log('✨ All migrations completed successfully!');
};

runMigrations();
