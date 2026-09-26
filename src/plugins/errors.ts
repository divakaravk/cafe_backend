import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** A deliberate, typed application error — thrown by route handlers/services
 * and mapped straight to `{ error: { code, message } }` with the right HTTP
 * status. Anything else (a bug, a driver error) becomes a 500 with a generic
 * message — never leaking internals to the client. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  badRequest: (message: string, code = 'BAD_REQUEST') => new AppError(400, code, message),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Permission denied') => new AppError(403, 'FORBIDDEN', message),
  conflict: (message: string, code = 'CONFLICT') => new AppError(409, code, message),
  tooManyRequests: (message = 'Too many requests') => new AppError(429, 'RATE_LIMITED', message),
};

// Same mapping the Dart client's `api_helper.dart` already applies to Postgrest
// error codes — kept so a message like "Duplicate entry..." reads the same
// regardless of which backend produced it.
function mapMysqlError(err: { code?: string; errno?: number }): AppError | null {
  switch (err.code) {
    case 'ER_DUP_ENTRY':
      return new AppError(409, 'DUPLICATE', 'Duplicate entry. This record already exists.');
    case 'ER_NO_REFERENCED_ROW_2':
    case 'ER_ROW_IS_REFERENCED_2':
      return new AppError(409, 'FK_VIOLATION', 'Cannot complete — a linked record is missing or in use.');
    case 'ER_CHECK_CONSTRAINT_VIOLATED':
      return new AppError(400, 'CHECK_VIOLATION', 'Invalid value for this field.');
    default:
      return null;
  }
}

export default fp(async function errorsPlugin(app: FastifyInstance) {
  app.setErrorHandler((err, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({
        error: { code: err.code, message: err.message },
        request_id: req.id,
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        request_id: req.id,
      });
    }
    const mapped = mapMysqlError(err as { code?: string });
    if (mapped) {
      return reply.status(mapped.status).send({
        error: { code: mapped.code, message: mapped.message },
        request_id: req.id,
      });
    }
    // Fastify's own validation errors carry a statusCode (400) — pass those through.
    const fastifyErr = err as { statusCode?: number; message?: string };
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      return reply.status(fastifyErr.statusCode).send({
        error: { code: 'BAD_REQUEST', message: fastifyErr.message ?? 'Bad request.' },
        request_id: req.id,
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
      request_id: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route: ${req.method} ${req.url}` },
      request_id: req.id,
    });
  });
});
