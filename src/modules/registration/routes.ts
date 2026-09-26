import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RequestRegistrationBody, VerifyOtpBody } from './schemas.js';
import * as registrationService from './service.js';

export default async function registrationRoutes(app: FastifyInstance) {
  app.post(
    '/public/registrations',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req) => {
      const body = RequestRegistrationBody.parse(req.body);
      return registrationService.requestCompanyRegistration(app, body);
    },
  );

  app.post(
    '/public/registrations/:id/verify',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = VerifyOtpBody.parse(req.body);
      const result = await registrationService.verifyCompanyRegistrationOtp(app, id, body.code);
      if (result.ok && result.company_id) {
        return { ...result, registration_token: registrationService.issueRegistrationToken(id, result.company_id) };
      }
      return result;
    },
  );

  app.post('/public/registrations/:id/admin', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        registration_token: z.string().min(10),
        user: z.object({
          user_name: z.string().min(1),
          employee_code: z.string().min(1),
          username: z.string().min(1),
          password: z.string().min(6),
          mob_number: z.string().nullable().optional(),
          user_email: z.string().nullable().optional(),
        }),
      })
      .parse(req.body);
    return registrationService.createFirstAdmin(app, {
      registrationId: id,
      registrationToken: body.registration_token,
      user: body.user,
    });
  });
}
