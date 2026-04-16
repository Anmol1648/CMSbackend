import { getCurrentUser } from './context';

export interface AuditData {
    created_by?: string;
    updated_by?: string;
    [key: string]: any;
}

/**
 * Automatically sets audit fields based on the current context user
 */
export const setAuditFields = (data: any, isUpdate = false) => {
    const user = getCurrentUser();
    const userId = user?.id || 'system';

    if (isUpdate) {
        return {
            ...data,
            updated_by: userId
        };
    }

    return {
        ...data,
        created_by: userId,
        updated_by: userId
    };
};
