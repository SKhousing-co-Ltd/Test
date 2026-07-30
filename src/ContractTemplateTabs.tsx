import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';

export type DocumentType = 'ordinary_lease' | 'fixed_term_building_lease' | 'parking' | 'bicycle_parking' | 'warehouse';
type Template = { document_type: DocumentType; display_name: string; requires_plan: boolean; active_revision_id: string | null };
const order: DocumentType[] = ['ordinary_lease', 'fixed_term_building_lease', 'parking', 'bicycle_parking', 'warehouse'];

export function ContractTemplateTabs({ contractId, currentType, onChanged }: { contractId: string; currentType: DocumentType; onChanged: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([]); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!supabase) return; void supabase.from('contract_document_template').select('document_type, display_name, requires_plan, active_revision_id').then(({ data }) => setTemplates((data ?? []) as Template[])); }, []);
  const select = async (next: Template) => {
    if (!supabase || next.document_type === currentType || !next.active_revision_id) return;
    if (!window.confirm(`契約書を「${next.display_name}」へ変更します。現在の入力内容とPDFは履歴へ退避されます。`)) return;
    setBusy(true); const { data: document } = await supabase.from('lease_contract_document').select('*').eq('lease_contract_id', contractId).maybeSingle();
    if (document) await supabase.from('lease_contract_document_history').insert({ lease_contract_id: contractId, document_type: document.document_type, archived_document: document });
    await supabase.from('lease_contract_document').update({ document_type: next.document_type, contract_document_template_revision_id: next.active_revision_id, field_values: {}, workflow_defaults: {}, manually_edited_fields: [], pdf_file_path: null, pdf_generated_at: null }).eq('lease_contract_id', contractId);
    setBusy(false); onChanged();
  };
  return <div className="contract-document-tabs" role="tablist">{order.map((type) => { const template = templates.find((item) => item.document_type === type); const ready = Boolean(template?.active_revision_id); return <button key={type} type="button" role="tab" aria-selected={currentType === type} className={currentType === type ? 'active' : ''} disabled={busy || !ready} onClick={() => template && void select(template)}>{template?.display_name ?? type}{!ready && <small>ひな型準備中</small>}</button>; })}</div>;
}
