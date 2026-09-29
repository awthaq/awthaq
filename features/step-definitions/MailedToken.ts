// EOTS-010: a mailed token travels as `Redacted` in the mail's `data`, so a
// step that plays the recipient unwraps it here, by narrowing rather than a cast.
import type { Mailer } from "@awthaq/ports";
import * as Redacted from "effect/Redacted";

export const mailedToken = (mail: Mailer.MailMessage): string => {
  const token = mail.data?.["token"];
  if (Redacted.isRedacted(token)) return String(Redacted.value(token));
  if (typeof token === "string") return token;
  throw new Error(`expected a token in the "${mail.template}" mail`);
};
