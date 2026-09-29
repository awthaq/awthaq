// @awthaq/react — Subject
//
// spec/behaviors/23-react.md, BEH-EA-179: the qadi `subject` is derived from
// `sessionAtom` — `AuthClientAtom.ts`'s `subjectAtom` gates the data this
// module converts on a settled, real session (EAR-002), so sign-out makes the
// subject `undefined` in the same registry batch rather than leaving an
// anonymous `AuthSubject` behind. The data itself is `SubjectContract.SubjectDto`
// (BEH-EA-026), served by `@awthaq/qadi`'s own endpoint (see that module's
// `SubjectApi.ts` for why a *separate* endpoint, not a field folded into the
// core session response).
import type { AuthSubject } from "@qadi/core";
import { makeSubject } from "@qadi/core";
import type { SubjectContract } from "@awthaq/api";
import type { PermissionKey } from "@qadi/core";

/**
 * A sound, runtime-checked narrowing of an arbitrary wire string into
 * `@qadi/core`'s `PermissionKey` template-literal type (`` `${string}:${string}` ``)
 * — not a cast: `PermissionKey` is structural, not branded, so nothing here
 * can *trust* a wire string is shaped this way without actually checking it.
 * `SubjectContract.SubjectDto.permissions` only ever holds values this
 * server-side `permissionKey` itself produced (`@awthaq/qadi`'s
 * `SubjectApi.ts`), so this predicate should never actually reject one in
 * practice — but "should never" is exactly the case a runtime check earns
 * its keep, over trusting the wire and asserting instead.
 */
const isPermissionKey = (value: string): value is PermissionKey => {
  const colonIndex = value.indexOf(":");
  return colonIndex > 0 && colonIndex === value.lastIndexOf(":") && colonIndex < value.length - 1;
};

/**
 * BEH-EA-179: `undefined` in, `undefined` out — a subject that has not
 * resolved yet yields no subject, so `QadiProvider`'s every gate stays
 * pending rather than momentarily granting or denying against nothing.
 * (Session gating is `subjectAtom`'s job, not this converter's.)
 */
export const toSubject = (dto: SubjectContract.SubjectDto | undefined): AuthSubject | undefined =>
  dto === undefined
    ? undefined
    : makeSubject({
        id: dto.id,
        roles: dto.roles,
        permissions: dto.permissions.filter(isPermissionKey),
        attributes: dto.attributes,
      });
