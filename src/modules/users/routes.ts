import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UpsertUserBody, UpdateOwnProfileBody } from './schemas.js';
import * as usersService from './service.js';
import { Errors } from '../../plugins/errors.js';

export default async function userRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: [app.authenticate, app.requirePerm('can_manage_users')] }, async (req) => {
    // Tenant from the token, not the request: a company user always lists
    // their own company. Only the owner may address another one explicitly.
    const q = z.object({ company_id: z.string().uuid().optional() }).parse(req.query);
    const companyId = req.user.role === 'owner' && q.company_id ? q.company_id : req.user.cid;
    if (!companyId) throw Errors.badRequest('No company associated with this account.');
    return usersService.getUsersForCompany(app, companyId);
  });

  app.get('/users/:id/permissions', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (id !== req.user.sub) {
      await app.requirePerm('can_manage_users')(req);
    }
    return usersService.getUserPermissions(app, id);
  });

  app.post('/users', { preHandler: [app.authenticate, app.requirePerm('can_manage_users')] }, async (req) => {
    const body = UpsertUserBody.parse(req.body);
    return usersService.upsertUserWithPermissions(app, {
      user: body.user,
      permissions: body.permissions,
      isNew: true,
      actingCompanyId: req.user.cid,
      actingRole: req.user.role,
    });
  });

  app.put('/users/:id', { preHandler: [app.authenticate, app.requirePerm('can_manage_users')] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpsertUserBody.parse(req.body);
    return usersService.upsertUserWithPermissions(app, {
      user: { ...body.user, id },
      permissions: body.permissions,
      isNew: false,
      actingCompanyId: req.user.cid,
      actingRole: req.user.role,
    });
  });

  app.post(
    '/users/:id/force-logout',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_users')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      if (id === req.user.sub) throw Errors.badRequest('You cannot force-logout your own account.');
      await usersService.forceLogoutUser(app, id, req.user.role === 'owner' ? null : req.user.cid);
      return { ok: true };
    },
  );

  app.patch('/users/me', { preHandler: app.authenticate }, async (req) => {
    const body = UpdateOwnProfileBody.parse(req.body);
    await usersService.updateOwnProfile(app, {
      userId: req.user.sub,
      userName: body.user_name,
      phone: body.mob_number,
      email: body.user_email,
      avatarUrl: body.avatar_url,
    });
    return { ok: true };
  });
}
