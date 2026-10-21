import { RentRollReconciliationPanel } from "./RentRollReconciliationPanel";
import type { ContractCapabilities } from "./lib/contract-capabilities";

export function RentRollReconciliationPage({ capabilities }: { capabilities: ContractCapabilities }) {
  return (
    <section className="rent-roll-page rent-roll-reconciliation-page">
      <div className="rent-roll-heading">
        <div>
          <p className="section-kicker">RECONCILIATION</p>
          <h2>レントロール整合性確認</h2>
          <p>旧レントロールと現在の登録情報の差異を確認します。正本のデータは更新しません。</p>
        </div>
      </div>
      <RentRollReconciliationPanel canManage={capabilities.canEditContract} />
    </section>
  );
}
