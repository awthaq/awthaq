// @awthaq/core — Tenant
//
// DRS-001/EP-001 (ADR-EA-018): the ambient `TenantContext` is defined in
// `@awthaq/ports` because `@awthaq/sql` (below core) reads it to stamp every
// row; this module is the domain-stratum name applications import.

import { Tenant } from "@awthaq/ports";

export const TenantContext = Tenant.TenantContext;
export const withTenant = Tenant.withTenant;
export const withoutTenant = Tenant.withoutTenant;
export const TenantConfigApplied = Tenant.TenantConfigApplied;
export const configApplied = Tenant.configApplied;
export const configInForce = Tenant.configInForce;
