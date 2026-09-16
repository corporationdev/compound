import { describe, expect, test } from 'bun:test';
import { canManageMembers, matchCloudToLocal, pickActiveOrganization } from '../src/lib/cloud-logic';

const org = (id: string, role = 'member') => ({ id, name: id, slug: id, role });

describe('pickActiveOrganization', () => {
  test('null while the list is unknown or empty, whatever is remembered', () => {
    expect(pickActiveOrganization(null, 'a')).toBeNull();
    expect(pickActiveOrganization([], 'a')).toBeNull();
  });

  test('the remembered one while the user still belongs to it', () => {
    expect(pickActiveOrganization([org('a'), org('b')], 'b')).toBe('b');
  });

  test('falls back to the first when nothing is remembered or it is gone', () => {
    expect(pickActiveOrganization([org('a'), org('b')], null)).toBe('a');
    expect(pickActiveOrganization([org('a'), org('b')], 'left')).toBe('a');
  });
});

describe('canManageMembers', () => {
  test('owners and admins can; members and nobody cannot', () => {
    expect(canManageMembers('owner')).toBe(true);
    expect(canManageMembers('admin')).toBe(true);
    expect(canManageMembers('member')).toBe(false);
    expect(canManageMembers(undefined)).toBe(false);
  });

  test('a comma-separated role list counts any managing role', () => {
    expect(canManageMembers('member,admin')).toBe(true);
    expect(canManageMembers('member, owner')).toBe(true);
  });
});

describe('matchCloudToLocal', () => {
  const cloud = [{ _id: 'p1' }, { _id: 'p2' }, { _id: 'p3' }];

  test('pairs each cloud project with the record carrying its id', () => {
    const records = [
      { dir: '/a', cloudProjectId: 'p1' },
      { dir: '/b' },
      { dir: '/c', cloudProjectId: 'p3' },
    ];
    const matches = matchCloudToLocal(cloud, records);
    expect(matches.get('p1')).toEqual({ dir: '/a', cloudProjectId: 'p1' });
    expect(matches.get('p2')).toBeUndefined();
    expect(matches.get('p3')).toEqual({ dir: '/c', cloudProjectId: 'p3' });
    expect(matches.size).toBe(2);
  });

  test('the first record wins when two folders hold the same project', () => {
    const records = [
      { dir: '/recent', cloudProjectId: 'p1' },
      { dir: '/older', cloudProjectId: 'p1' },
    ];
    expect(matchCloudToLocal(cloud, records).get('p1')?.dir).toBe('/recent');
  });

  test('records for projects not on the list (another organization, archived) are left out', () => {
    const records = [{ dir: '/x', cloudProjectId: 'elsewhere' }];
    expect(matchCloudToLocal(cloud, records).size).toBe(0);
  });

  test('is pure: nothing given is changed', () => {
    const records = [{ dir: '/a', cloudProjectId: 'p1' }];
    const cloudCopy = structuredClone(cloud);
    const recordsCopy = structuredClone(records);
    matchCloudToLocal(cloud, records);
    expect(cloud).toEqual(cloudCopy);
    expect(records).toEqual(recordsCopy);
  });
});
