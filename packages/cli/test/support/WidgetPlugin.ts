// A toy plugin for the doctor/config suites: one *unprotected* mutating endpoint (no
// `CsrfProtection`), and a configuration reference holding a plain-string secret next to a
// `Redacted` one, both declared through a descriptor — so redaction is proved against a shape
// that could leak, not against a config with nothing to hide.
import { Auth, AuthPlugin, ConfigDescriptor } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

export interface WidgetConfigShape {
  readonly minLength: number;
  readonly clientSecret: string;
  readonly signingKey: Redacted.Redacted<string>;
  readonly databaseUrl: string;
}

export const WidgetConfig = Context.Reference<WidgetConfigShape>("test/cli/WidgetConfig", {
  defaultValue: () => ({
    minLength: 12,
    clientSecret: "sk-default-secret",
    signingKey: Redacted.make("default-signing-key"),
    databaseUrl: "postgres://app:default-password@db.internal/app",
  }),
});

const WidgetApi = HttpApi.make("auth").add(
  HttpApiGroup.make("widget")
    // A mutating endpoint with no CsrfProtection: the "csrf disabled" finding.
    .add(HttpApiEndpoint.post("create", "/widget", { success: Schema.String }))
    .add(HttpApiEndpoint.get("read", "/widget", { success: Schema.String })),
);

export class Widget extends AuthPlugin.Service<Widget, { readonly ok: true }>()("widget", {
  apiVersion: 1,
  contract: WidgetApi,
  config: [
    ConfigDescriptor.make(WidgetConfig, {
      sensitive: ["clientSecret"],
      audit: (value) =>
        value.minLength < 8
          ? [ConfigDescriptor.finding("warning", "widget-short", "minLength is below 8")]
          : [],
    }),
  ],
}) {
  static readonly layer = AuthPlugin.layer(Widget, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(WidgetApi, "widget", (handlers) =>
      handlers
        .handle("create", () => Effect.succeed("created"))
        .handle("read", () => Effect.succeed("read")),
    ),
  });
}

export const widgetOnly = Auth.make([Widget]);
