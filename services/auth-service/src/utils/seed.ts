import { db } from '../models/prisma';
import { hashPassword } from './password.util';
import { v4 as uuidv4 } from 'uuid';
import { serviceHandler } from '@shared/core';

const seed = serviceHandler(async () => {
    try {
        const hashedPassword = await hashPassword('Admin@123');
        
        const user = await db.user.upsert({
            where: { email: 'admin@test.com' },
            update: {
                password_hash: hashedPassword,
                first_name: 'Admin',
                last_name: 'User',
                is_active: true,
                mfa_enabled: false,
                tenant_id: uuidv4()
            },
            create: {
                email: 'admin@test.com',
                password_hash: hashedPassword,
                first_name: 'Admin',
                last_name: 'User',
                is_active: true,
                mfa_enabled: false,
                tenant_id: uuidv4()
            }
        });

        // Seed profile
        await db.userProfile.upsert({
            where: { user_id: user.id },
            update: {
                phone: '1234567890',
                city: 'Delhi',
                country: 'India',
                gender: 'MALE'
            },
            create: {
                user_id: user.id,
                phone: '1234567890',
                city: 'Delhi',
                country: 'India',
                gender: 'MALE'
            }
        });

        console.log('Seed success: Admin user, profile, and security fields preserved.', user.id);
        process.exit(0);
    } catch (error) {
        console.error('Seed failed:', error);
        process.exit(1);
    }
});

seed();
