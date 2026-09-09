import { deployment } from './deployment';
import { deriveEnvTier, getStageKind } from './stage-kind';

export function validateStage(stage: string): string {
  // Leave room in DNS labels for app-/server-/compound-media- prefixes.
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stage) ||
    stage.length > 48 ||
    getStageKind(stage) === 'unknown'
  ) {
    throw new Error(`Unsupported stage: ${stage}`);
  }
  return stage;
}
export function projectsFolderNameForStage(stage: string): string {
  return getStageKind(validateStage(stage)) === 'production' ? 'compound' : `compound-${stage}`;
}
export function resolveRuntimeContext(
  stage: string,
  options: {
    convexUrl?: string;
    rootDomain?: string;
    productionConvexDeployment?: string;
  } = {},
) {
  validateStage(stage);
  const kind = getStageKind(stage);
  const local = kind === 'dev' || kind === 'sandbox';
  const production = kind === 'production';
  const rootDomain = options.rootDomain ?? deployment.rootDomain;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(rootDomain)) {
    throw new Error('Set Compound’s public rootDomain in packages/config/src/deployment.ts');
  }
  const productionName =
    options.productionConvexDeployment ?? deployment.productionConvexDeployment;
  if (production && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(productionName)) {
    throw new Error('Set productionConvexDeployment in packages/config/src/deployment.ts');
  }
  const convexUrl = production ? `https://${productionName}.convex.cloud` : options.convexUrl;
  if (!convexUrl || !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud$/.test(convexUrl)) {
    throw new Error(
      `Missing hosted Convex deployment URL for ${stage}. Configure Convex locally or provide its deployment output in CI.`,
    );
  }
  if (production && options.convexUrl && options.convexUrl !== convexUrl)
    throw new Error('Production Convex URL does not match the committed deployment identity');
  const convexSiteUrl = convexUrl.replace('.convex.cloud', '.convex.site');
  const webUrl = local
    ? 'http://localhost:5173'
    : `https://${production ? 'app' : `app-${stage}`}.${rootDomain}`;
  const serverHostname = `${production ? 'server' : `server-${stage}`}.${rootDomain}`;
  // PostBob's dev tunnel forwards this stable hostname to the local Worker on :3000.
  const serverUrl = `https://${serverHostname}`;
  return {
    stage,
    stageKind: kind,
    envTier: deriveEnvTier(stage),
    convexUrl,
    convexSiteUrl,
    webUrl,
    serverUrl,
    serverHostname,
    bucket: `compound-media-${stage}`,
    backendEnv: { SITE_URL: webUrl, RESEND_FROM_EMAIL: `Compound <no-reply@${rootDomain}>` },
    serverBindings: { CONVEX_URL: convexUrl, CORS_ORIGIN: webUrl },
    webClientEnv: {
      VITE_CONVEX_URL: convexUrl,
      VITE_CONVEX_SITE_URL: convexSiteUrl,
      VITE_SERVER_URL: serverUrl,
    },
    desktopConfig: {
      stage,
      projectsFolderName: projectsFolderNameForStage(stage),
      convexUrl,
      authUrl: convexSiteUrl,
      serverUrl,
    },
  };
}
