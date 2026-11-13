// @awthaq/core — Tenant
//
// DRS-001/EP-001 (ADR-EA-018): the ambient `TenantContext` is defined in
// `@awthaq/ports` because `@awthaq/sql` (below core) reads it to stamp every
// row; this module is the domain-stratum name applications import.

import { Tenant } from "@awthaq/ports";
import type * as Context from "effect/Context";

export const TenantContext = Tenant.TenantContext;
export const withTenant = Tenant.withTenant;
export const withoutTenant = Tenant.withoutTenant;
export const TenantConfigApplied = Tenant.TenantConfigApplied;
export const configApplied = Tenant.configApplied;
export const perTenant = Tenant.perTenant;
export const perDeployment = Tenant.perDeployment;
export const resolveConfig = Tenant.resolveConfig;
export const inForce = Tenant.inForce;
export const DeploymentConfigApplied = Tenant.DeploymentConfigApplied;
export type ConfigScope = Tenant.ConfigScope;
export type PerTenant<I, A, K extends Context.Key<I, A> = Context.Key<I, A>> = Tenant.PerTenant<
  I,
  A,
  K
>;
export type PerDeployment<
  I,
  A,
  K extends Context.Key<I, A> = Context.Key<I, A>,
> = Tenant.PerDeployment<I, A, K>;
export type Declared<I, A, K extends Context.Key<I, A> = Context.Key<I, A>> = Tenant.Declared<
  I,
  A,
  K
>;
