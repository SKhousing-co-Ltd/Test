export type RentRollEndInfo = {
  actualEndDate: string | null;
  leaseEndDate: string | null;
  contractEndDate: string | null;
  leaseTermType: string | null;
  terminationNote: boolean;
  pendingTerminationDate: string | null;
};

export function classifyRentRollEnd(info: RentRollEndInfo, asOfDate: string) {
  const future = (date: string | null) => date && date > asOfDate ? date : null;
  const pendingDate = info.pendingTerminationDate;
  const actualEndDate = future(info.actualEndDate);
  const fixedTermEndDate = info.leaseTermType === 'fixed_term' ? future(info.contractEndDate) : null;
  const unitEndDate = future(info.leaseEndDate);
  return {
    scheduled: Boolean(pendingDate || actualEndDate || info.terminationNote),
    inProgress: Boolean(pendingDate),
    terminationDate: pendingDate || actualEndDate,
    fixedTermEndDate,
    unitEndDate: unitEndDate && unitEndDate !== fixedTermEndDate && unitEndDate !== actualEndDate && unitEndDate !== pendingDate ? unitEndDate : null,
  };
}
