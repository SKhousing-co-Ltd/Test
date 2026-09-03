export type AccountRole = 'admin' | 'manager' | 'staff' | 'viewer';

export type ContractCapabilities = {
  canViewContract: boolean;
  canEditContract: boolean;
  canEditParkingContract: boolean;
  canViewAuditData: boolean;
};

export function contractCapabilitiesForRole(role: AccountRole): ContractCapabilities {
  const canManage = role === 'admin' || role === 'manager';
  return {
    canViewContract: true,
    canEditContract: canManage,
    canEditParkingContract: canManage,
    canViewAuditData: role !== 'viewer',
  };
}
