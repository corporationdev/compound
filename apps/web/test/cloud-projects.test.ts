import { describe, expect, test } from 'bun:test';
import { canManageMembers, pickActiveOrganization } from '../src/lib/cloud-logic';

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
