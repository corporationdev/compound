import { deployment } from './deployment';

/**
 * Where pull request installers and verification recordings live: one public
 * R2 bucket for the account, keyed by pull request, behind a custom domain so
 * a link in a PR comment opens and plays in the browser. Everything under a
 * PR's prefix is deleted when the PR closes.
 */
export const evidence = {
  bucket: 'compound-evidence',
  domain: `evidence.${deployment.rootDomain}`,
  prefix: (pullRequest: number) => `pr-${pullRequest}/`,
  url: (key: string) => `https://evidence.${deployment.rootDomain}/${key.split('/').map(encodeURIComponent).join('/')}`,
} as const;
