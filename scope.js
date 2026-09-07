/* ============================================================
   DIC ALUMNI PLATFORM — DEPARTMENT SCOPE
   Phase 7D.

   One definition of "which departments may this account reach", used by every
   endpoint that needs it. The alternative — a role check written out at each
   call site — is how a scope ends up enforced in eleven places and forgotten
   in the twelfth.

   This is NOT a dynamic RBAC system. There are no permission rows, no policy
   engine and nothing an administrator can configure. It is one question with
   three possible answers, decided by the role and one foreign key.

   The model:

     super_admin   every department, and records belonging to none
     univ_admin    every department, and records belonging to none
                   (institution-wide: the two are identical for scope purposes;
                    they differ elsewhere, in what they may DO)
     dept_admin    its own department, and nothing else
     moderator     not department-scoped — moderation is a platform-wide queue
                   and was already defined that way
     alumni        not department-scoped — a member's access is governed by
                   privacy settings and ownership, which Phase 7C-1 settled

   Fail closed. A dept_admin whose account has no department reaches NOTHING,
   not everything. That case is real: no staff account carried a department
   before this phase, because there was nothing to carry. An administrator
   assigns one deliberately, and until they do the safe answer is zero rows.

   A record with department_id NULL — an alumnus whose department was never
   captured, an event organised by no single department — belongs to the
   institution, not to a department. Institution-wide roles see it; no
   department admin does. That is the honest reading of "we do not know", and
   it is the safe one: an unknown record is never handed to the wrong
   department by default.
   ============================================================ */

const INSTITUTION_WIDE_ROLES = ['super_admin', 'univ_admin'];
const DEPARTMENT_SCOPED_ROLES = ['dept_admin'];

/** True when this role sees every department without restriction. */
function isInstitutionWide(role) {
  return INSTITUTION_WIDE_ROLES.includes(role);
}

/**
 * What this account may reach.
 * @returns {{kind: 'institution'|'department'|'none'|'unscoped', departmentId: number|null}}
 *   institution — every record, whatever its department
 *   department  — records in departmentId only
 *   none        — a department-scoped account with no department: NOTHING
 *   unscoped    — this dimension does not apply to the role at all
 *
 * The difference between 'none' and 'unscoped' is the one that matters, and
 * collapsing them is a bug in both directions. A moderator is 'unscoped':
 * moderation is a platform-wide queue and §1 says so, and treating it as 'none'
 * would have silently emptied the moderation and event screens for the one role
 * that exists to work them. A dept_admin with no department is 'none': it is
 * department-scoped and its department is unknown, so the safe answer is zero
 * rows rather than every row.
 */
function scopeOf(user) {
  if (!user) return { kind: 'none', departmentId: null };
  if (isInstitutionWide(user.role)) return { kind: 'institution', departmentId: null };
  if (DEPARTMENT_SCOPED_ROLES.includes(user.role)) {
    const id = Number.isInteger(user.departmentId) ? user.departmentId : null;
    return id ? { kind: 'department', departmentId: id } : { kind: 'none', departmentId: null };
  }
  /* Not department-scoped. What such a role may reach at all is decided by its
     route guard; this function has no opinion and must not invent one. */
  return { kind: 'unscoped', departmentId: null };
}

/**
 * A SQL fragment restricting `column` (a department_id) to this account's scope.
 * Appends to `params` and returns a string beginning ' AND ' — or '' when the
 * account is institution-wide and no restriction applies.
 *
 * The 'none' case emits ' AND FALSE' rather than an empty string. That
 * difference is the whole point: an unscoped administrator must return no rows,
 * and a missing clause would return all of them.
 */
function sqlFor(user, column, params) {
  const s = scopeOf(user);
  if (s.kind === 'institution' || s.kind === 'unscoped') return '';
  if (s.kind === 'none') return ' AND FALSE';
  params.push(s.departmentId);
  return ` AND ${column} = $${params.length}`;
}

/**
 * May this account reach a record belonging to this department?
 * `departmentId` may be null, meaning the record belongs to no department.
 */
function canReach(user, departmentId) {
  const s = scopeOf(user);
  if (s.kind === 'institution' || s.kind === 'unscoped') return true;
  if (s.kind === 'none') return false;
  return departmentId !== null && departmentId !== undefined &&
         Number(departmentId) === s.departmentId;
}

/** The refusal an out-of-scope request gets. Deliberately says nothing about
    whether the record exists — that difference is an enumeration oracle. */
const OUT_OF_SCOPE = {
  error: 'That record is outside your department.',
  code: 'out_of_scope'
};

/** A dept_admin with no department, described for a human rather than as a bug. */
const NO_DEPARTMENT = {
  error: 'Your administrator account has no department assigned, so it can reach no ' +
         'departmental records. A super administrator can assign one.',
  code: 'no_department'
};

module.exports = {
  INSTITUTION_WIDE_ROLES, DEPARTMENT_SCOPED_ROLES,
  isInstitutionWide, scopeOf, sqlFor, canReach,
  OUT_OF_SCOPE, NO_DEPARTMENT
};
