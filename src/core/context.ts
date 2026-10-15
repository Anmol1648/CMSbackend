import { AsyncLocalStorage } from 'async_hooks';

export interface UserContext {
    id: string;
    email: string;
    tenantId: string;
}

const contextStorage = new AsyncLocalStorage<UserContext>();

export const runWithUser = (user: UserContext, next: () => any) => {
    return contextStorage.run(user, next);
};

export const getCurrentUser = (): UserContext | undefined => {
    return contextStorage.getStore();
};
