-- App 87 uses circled numerals (①..③). Ignore AppSuite field error
-- objects instead of serializing them as business values, while retaining
-- the earlier ASCII-number aliases for compatibility with future forms.

create or replace function public.appsuite_text_value(payload jsonb, field_name text)
returns text
language sql
immutable parallel safe
set search_path = public
as $$
  select case
    when jsonb_typeof(payload -> field_name) = 'object'
      and payload -> field_name ? 'error' then null
    else nullif(btrim(coalesce(
      payload -> field_name ->> 'val',
      payload -> field_name ->> 'value',
      payload ->> field_name
    )), '')
  end
$$;

create or replace function public.stage_appsuite_procurement_record()
returns trigger
language plpgsql
set search_path = public
as $$
declare line_no integer;
declare line_label text;
declare line_labels constant text[] := array['①', '②', '③'];
declare vendor_value text;
declare amount_value numeric;
declare title_value text;
declare payment_date_value date;
declare inbox_id uuid;
begin
  if new.app_id <> '87' or not new.is_present
     or coalesce(new.approval_status, '') not in ('完了', '承認', '決裁済み') then
    return new;
  end if;

  for line_no in 1..3 loop
    line_label := line_labels[line_no];
    inbox_id := null;
    vendor_value := coalesce(
      public.appsuite_text_value(new.raw_payload, format('発注業者%s', line_label)),
      public.appsuite_text_value(new.raw_payload, format('発注業者%s', line_no))
    );
    if vendor_value is null and line_no = 1 then
      vendor_value := public.appsuite_text_value(new.raw_payload, '発注先');
    end if;
    amount_value := coalesce(
      public.parse_external_amount(public.appsuite_text_value(new.raw_payload, format('発注金額%s（税込）', line_label))),
      public.parse_external_amount(public.appsuite_text_value(new.raw_payload, format('発注金額%s（税込）', line_no)))
    );
    title_value := coalesce(
      public.appsuite_text_value(new.raw_payload, format('発注内容%s', line_label)),
      public.appsuite_text_value(new.raw_payload, format('発注内容%s', line_no)),
      public.appsuite_text_value(new.raw_payload, '不具合内容'),
      public.appsuite_text_value(new.raw_payload, '詳細')
    );
    payment_date_value := coalesce(
      public.parse_external_date(public.appsuite_text_value(new.raw_payload, format('支払予定日%s', line_label))),
      public.parse_external_date(public.appsuite_text_value(new.raw_payload, format('支払予定日%s', line_no)))
    );

    if vendor_value is not null or amount_value is not null then
      insert into public.appsuite_procurement_inbox (
        appsuite_record_id, line_number, ringi_number, property_code, property_name,
        vendor_name, title, description, gross_amount, expected_payment_date, source_payload
      ) values (
        new.appsuite_record_id, line_no, left(new.ringi_number, 100),
        left(public.appsuite_text_value(new.raw_payload, '物件コード'), 100),
        left(coalesce(
          public.appsuite_text_value(new.raw_payload, '建物名称'),
          public.appsuite_text_value(new.raw_payload, '物件名')
        ), 200),
        left(vendor_value, 200), left(title_value, 300),
        public.appsuite_text_value(new.raw_payload, '詳細'), amount_value,
        payment_date_value, new.raw_payload
      )
      on conflict (appsuite_record_id, line_number) do update set
        ringi_number = excluded.ringi_number,
        property_code = excluded.property_code,
        property_name = excluded.property_name,
        vendor_name = excluded.vendor_name,
        title = excluded.title,
        description = excluded.description,
        gross_amount = excluded.gross_amount,
        expected_payment_date = excluded.expected_payment_date,
        source_payload = excluded.source_payload,
        updated_at = now()
      where public.appsuite_procurement_inbox.match_status not in ('imported', 'ignored')
      returning appsuite_procurement_inbox_id into inbox_id;

      if inbox_id is not null then
        perform public.reconcile_appsuite_procurement_inbox(inbox_id);
      end if;
    end if;
  end loop;
  return new;
end;
$$;

-- Remove only non-imported rows proven to have been derived from AppSuite's
-- error object by the old fallback, then deterministically rebuild from source.
delete from public.appsuite_procurement_inbox
where match_status = 'action_required'
  and imported_procurement_order_id is null
  and matched_vendor_id is null
  and gross_amount is null
  and source_payload -> '発注先' ->> 'error' = 'under_maintenance';

update public.appsuite_record
set raw_payload = raw_payload
where app_id = '87' and is_present;

comment on function public.appsuite_text_value(jsonb, text) is
  'AppSuiteフィールドのval/valueを文字列化し、errorオブジェクトは業務値として扱わない。';
