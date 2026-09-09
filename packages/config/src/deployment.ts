/** Public deployment identity. Production Convex identity is set when provisioned.
 * PostBob keeps the equivalent domain and production Convex identity in runtime.ts.
 * They belong in version control, never in a secret vault.
 */
export const deployment = {
  rootDomain: 'compound.mov',
  productionConvexDeployment: 'strong-panda-857',
} as const;
