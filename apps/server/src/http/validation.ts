import { z } from 'zod';
import { DomainError } from '../infra/errors';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new DomainError('VALIDATION_ERROR', z.prettifyError(result.error), 400);
  }
  return result.data;
}

export const idParam = z.object({ id: z.string().min(1) });
export const numericIdParam = z.object({ id: z.coerce.number().int().positive() });

/** 時間參數接受 epoch 毫秒或 ISO 字串 */
export const timeValue = z.union([
  z.coerce.number().int(),
  z.iso.datetime({ offset: true }).transform((s) => Date.parse(s)),
]);
