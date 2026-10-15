import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validationError } from '../core/errors';

/** Validates { body, query, params } against a schema; errors list the bad fields. */
export const validate = (schema: z.ZodObject<any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            await schema.parseAsync({
                body: req.body,
                query: req.query,
                params: req.params,
            });
            return next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                return next(validationError(error, true));
            }
            return next(error);
        }
    };
};
