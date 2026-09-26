import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { Errors } from './errors.js';

export type PermissionKey =
  | 'can_view_dashboard'
  | 'can_create_bill'
  | 'can_edit_bill'
  | 'can_cancel_bill'
  | 'can_apply_discount'
  | 'can_manage_items'
  | 'can_manage_tables'
  | 'can_view_reports'
  | 'can_manage_users'
  | 'can_manage_settings'
  | 'can_void_items'
  | 'can_manage_stock';

declare module 'fastify' {
  interface FastifyInstance {
    /** Requires the signed-in user to hold [perm]. `admin`/`owner` always pass.
     * Governed by `RBAC_ENFORCE` (see docs/backend-migration/PLAN.md §4.5):
     * while false, a failing check is only logged (`rbac.would_deny` warning +
     * an `audit_log` row) so the flag can be flipped on later without
     * surprising a real cashier mid-shift. */
    requirePerm: (perm: PermissionKey) => (req: FastifyRequest, reply?: FastifyReply) => Promise<void>;
  }
}

export default fp(async function rbacPlugin(app: FastifyInstance) {
  app.decorate('requirePerm', (perm: PermissionKey) => {
    return async (req: FastifyRequest) => {
      const { sub, role } = req.user;
      if (role === 'admin' || role === 'owner') return;

      const [rows] = await app.db.query(`SELECT ${perm} AS allowed FROM user_permission WHERE user_id = ?`, [sub]);
      const allowed = (rows as { allowed: boolean }[])[0]?.allowed ?? false;
      if (allowed) return;

      if (!config.RBAC_ENFORCE) {
        req.log.warn({ userId: sub, perm, route: req.routeOptions.url ?? req.url }, 'rbac.would_deny');
        await app.db
          .query(
            'INSERT INTO audit_log (user_id, action, entity, meta) VALUES (?, ?, ?, CAST(? AS JSON))',
            [sub, 'rbac.would_deny', perm, JSON.stringify({ route: req.routeOptions.url ?? req.url })],
          )
          .catch(() => {}); // audit logging must never break the request
        return;
      }
      throw Errors.forbidden();
    };
  });
});
