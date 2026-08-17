import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-billone-webhook-secret',
};

type IncomingInvoice = {
  sourceInvoiceId?: unknown;
  invoiceNumber?: unknown;
  supplierId?: unknown;
  supplierName?: unknown;
  invoiceDate?: unknown;
  receivedDate?: unknown;
  dueDate?: unknown;
  subtotalAmount?: unknown;
  taxAmount?: unknown;
  grossAmount?: unknown;
  documentUrl?: unknown;
  orderNumber?: unknown;
  ringiNumber?: unknown;
  propertyCode?: unknown;
  propertyName?: unknown;
  accountId?: unknown;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('BILLONE_WEBHOOK_SECRET');
  if (!expectedSecret || request.headers.get('x-billone-webhook-secret') !== expectedSecret) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await request.json() as { invoices?: IncomingInvoice[] } | IncomingInvoice;
    const invoices = Array.isArray((body as { invoices?: IncomingInvoice[] }).invoices)
      ? (body as { invoices: IncomingInvoice[] }).invoices
      : [body as IncomingInvoice];
    if (!invoices.length || invoices.length > 500) return json({ error: 'invoices must contain 1 to 500 items' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const accepted: Array<{ sourceInvoiceId: string; inboxId: string; matchStatus: string; issues: string[] }> = [];
    for (const invoice of invoices) {
      const sourceInvoiceId = text(invoice.sourceInvoiceId);
      if (!sourceInvoiceId) return json({ error: 'sourceInvoiceId is required for every invoice' }, 400);
      const { data: existing, error: existingError } = await admin.from('billone_invoice_inbox')
        .select('billone_invoice_inbox_id, match_status, issues, imported_vendor_invoice_id')
        .eq('source_invoice_id', sourceInvoiceId).maybeSingle();
      if (existingError) throw existingError;
      if (existing?.imported_vendor_invoice_id) {
        accepted.push({ sourceInvoiceId, inboxId: existing.billone_invoice_inbox_id, matchStatus: existing.match_status, issues: existing.issues ?? [] });
        continue;
      }
      const row = {
        source_invoice_id: sourceInvoiceId,
        invoice_number: text(invoice.invoiceNumber),
        supplier_id: text(invoice.supplierId),
        supplier_name: text(invoice.supplierName),
        invoice_date: text(invoice.invoiceDate),
        received_date: text(invoice.receivedDate) ?? new Date().toISOString().slice(0, 10),
        due_date: text(invoice.dueDate),
        subtotal_amount: amount(invoice.subtotalAmount),
        tax_amount: amount(invoice.taxAmount),
        gross_amount: amount(invoice.grossAmount),
        document_url: text(invoice.documentUrl),
        order_number: text(invoice.orderNumber),
        ringi_number: text(invoice.ringiNumber),
        property_code: text(invoice.propertyCode),
        property_name: text(invoice.propertyName),
        account_id: text(invoice.accountId),
        raw_payload: invoice,
        last_received_at: new Date().toISOString(),
      };
      const { data: inbox, error: upsertError } = await admin.from('billone_invoice_inbox')
        .upsert(row, { onConflict: 'source_invoice_id', ignoreDuplicates: false })
        .select('billone_invoice_inbox_id, match_status, imported_vendor_invoice_id')
        .single();
      if (upsertError) throw upsertError;
      if (!inbox.imported_vendor_invoice_id) {
        const { error: reconcileError } = await admin.rpc('reconcile_billone_invoice_inbox', { target_id: inbox.billone_invoice_inbox_id });
        if (reconcileError) throw reconcileError;
      }
      const { data: matched, error: readError } = await admin.from('billone_invoice_inbox')
        .select('match_status, issues').eq('billone_invoice_inbox_id', inbox.billone_invoice_inbox_id).single();
      if (readError) throw readError;
      accepted.push({ sourceInvoiceId, inboxId: inbox.billone_invoice_inbox_id, matchStatus: matched.match_status, issues: matched.issues ?? [] });
    }
    return json({ accepted });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
