// EOTS-010: a mailed token travels as `Redacted` in the mail's `data`; `TestMailbox.secret` unwraps it.
import type { Mailer } from "@awthaq/ports";
import { TestMailbox } from "@awthaq/test";

export const mailedToken = (mail: Mailer.MailMessage): string => TestMailbox.secret(mail);
