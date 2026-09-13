// @effect-auth/react — Subject
//
// spec/behaviors/23-react.md, BEH-EA-179: "the React provider tree MUST
// derive qadi's `subject` prop from `sessionAtom`'s current value, not from
// a second, independently fetched source." The actual data this reads is
// `AuthClientAtom.ts`'s `subjectDtoAtom` — `@effect-auth/api`'s
// `SubjectContract.SubjectDto` (BEH-EA-026), served by
// `@effect-auth/qadi`'s own endpoint (see that module's `SubjectApi.ts` for
// why a *separate* endpoint, not a field folded into the core session
// response) — not a second, independently-*chosen* source the application
// picks itself.
import type { AuthSubject } from "@qadi/core";
import { makeSubject } from "@qadi/core";
import type { SubjectContract } from "@effect-auth/api";
import type { PermissionKey } from "@qadi/core";

/**
 * A sound, runtime-checked narrowing of an arbitrary wire string into
 * `@qadi/core`'s `PermissionKey` template-literal type (`` `${string}:${string}` ``)
 * — not a cast: `PermissionKey` is structural, not branded, so nothing here
 * can *trust* a wire string is shaped this way without actually checking it.
 * `SubjectContract.SubjectDto.permissions` only ever holds values this
 * server-side `permissionKey` itself produced (`@effect-auth/qadi`'s
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
