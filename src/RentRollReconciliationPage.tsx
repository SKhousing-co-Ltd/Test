import { RentRollReconciliationPanel } from "./RentRollReconciliationPanel";
import type { ContractCapabilities } from "./lib/contract-capabilities";

export function RentRollReconciliationPage({ capabilities }: { capabilities: ContractCapabilities }) {
  return (
    <section className="rent-roll-page rent-roll-reconciliation-page">
      <div className="rent-roll-heading">
        <div>
          <p className="section-kicker">RECONCILIATION</p>
          <h2>レントロール整合性確認</h2>
          <p>取込済みの賃貸借状況表と、比較元の基準日時点のシステム上のレントロールを物件別に比較します。</p>
        </div>
      </div>
      <RentRollReconciliationPanel canManage={capabilities.canEditContract} />
    </section>
  );
}
