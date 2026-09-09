import { deployment } from './deployment';

export const release = {
  bucket: 'compound-releases-prod',
  downloadUrl: `https://${deployment.rootDomain}/download`,
  dmg: 'Compound-mac-universal.dmg',
  zip: 'Compound-mac-universal.zip',
} as const;

export function releaseVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error('A release requires a stable x.y.z version');
  return value;
}
