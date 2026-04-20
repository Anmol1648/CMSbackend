import { PrismaClient } from '@prisma/client';
import { setAuditFields, getCurrentUser } from '@shared/core';

const prisma = new PrismaClient();

const db = prisma.$extends({
    query: {
        $allModels: {
            async $allOperations({ model, operation, args, query }) {
                // 1. Skip auditing for specified models to avoid infinite loops or schema mismatches
                if (model === 'AuditLog' || model === 'RefreshToken' || model === 'PasswordResetToken' || model === 'Menu' || model === 'Permission') {
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
                const auditOperations = ['create', 'update', 'delete', 'createMany', 'deleteMany', 'updateMany'];
                if (auditOperations.includes(operation)) {
                    const user = getCurrentUser();

                    // Construct record_id carefully for bulk operations
                    let recordId = 'unknown';
                    if ((result as any)?.id) {
                        recordId = (result as any).id;
                    } else if ((args as any).where?.id) {
                        recordId = (args as any).where.id;
                    } else if (operation.includes('Many')) {
                        // For bulk ops, record the scope of the operation
                        recordId = JSON.stringify((args as any).where || 'bulk');
                    }

                    prisma.auditLog.create({
                        data: {
                            table_name: model,
                            record_id: recordId,
                            operation: operation.toUpperCase(),
                            old_values: previousData || (operation.includes('Delete') ? (args as any) : undefined),
                            new_values: operation.includes('delete') ? undefined : (result || (args as any).data),
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

