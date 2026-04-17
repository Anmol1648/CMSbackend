import { PrismaClient } from '@prisma/client';
import { setAuditFields, getCurrentUser } from '@shared/core';

const prisma = new PrismaClient();

const db = prisma.$extends({
    query: {
        $allModels: {
            async $allOperations({ model, operation, args, query }) {
                // 1. Skip auditing for specified models to avoid infinite loops or schema mismatches
                if (model === 'AuditLog' || model === 'RefreshToken' || model === 'PasswordResetToken') {
                    return query(args);
                }

                // 2. Inject audit fields for mutations
                if (['create', 'createMany', 'update', 'updateMany', 'upsert', 'connectOrCreate'].includes(operation)) {
                    if (operation === 'create') {
                        args.data = setAuditFields(args.data, false);
                    } else if (operation === 'update') {
                        args.data = setAuditFields(args.data, true);
                    } else if (operation === 'upsert') {
                        args.create = setAuditFields(args.create, false);
                        args.update = setAuditFields(args.update, true);
                    }
                }

                // 3. Capture previous state for Updates/Deletes
                let previousData: any = null;
                if (['update', 'delete'].includes(operation) && (args as any).where) {
                    try {
                        previousData = await (prisma as any)[model].findUnique({ where: (args as any).where });
                    } catch (e) {
                        // Ignore if findUnique fails
                    }
                }

                // 4. Execute the original query
                const result = await query(args);

                // 5. Create Audit Log (Asynchronous)
                if (['create', 'update', 'delete'].includes(operation)) {
                    const user = getCurrentUser();
                    
                    // We use a separate prisma instance (without extensions) to write the log
                    // to avoid infinite recursion and ensure the log is saved.
                    prisma.auditLog.create({
                        data: {
                            table_name: model,
                            record_id: (result as any)?.id || (args as any).where?.id || 'unknown',
                            operation: operation.toUpperCase(),
                            old_values: previousData || undefined,
                            new_values: operation === 'delete' ? undefined : (result as any),
                            user_id: user?.id || 'system'
                        }
                    }).catch(err => console.error('[AuditLog Error]', err));
                }

                return result;
            },
        },
    },
});

export default db;
export { db };

