// @awthaq/device-authorization — Plugin
//
// OAuth 2.0 Device Authorization Grant (RFC 8628): an input-constrained client (the `awthaq` CLI, a
// TV, a set-top box) asks `POST /device/code` for a short user code, the person approves it on a second,
// signed-in device, and the client's `POST /device/token` poll receives an ordinary bearer session.
//
// Implemented: DeviceAuthorization.ts (spec/models/13-device-authorization.md, BEH-EA-310 to BEH-EA-317),
// DeviceAuthorizationApi.ts (the contract), UserCode.ts (the codes), DeviceGrantRecords.ts and
// DeviceClientRecords.ts (persistence). See spec/overview.md for the full package map.

export * as DeviceAuthorization from "./DeviceAuthorization.ts";
export * as DeviceAuthorizationApi from "./DeviceAuthorizationApi.ts";
export * as DeviceClientRecords from "./DeviceClientRecords.ts";
export * as DeviceGrantRecords from "./DeviceGrantRecords.ts";
export * as UserCode from "./UserCode.ts";
