-- Record the two rent-roll corrections previously applied directly to the
-- linked database. The guarded branches make this safe on that already-fixed
-- database while still reproducing the corrections on databases at the
-- pre-correction state.
do $$
declare
  v_fukuoka_unit_id uuid := '4fe211e9-03c4-4b6a-86e2-c42baf0ae674';
  v_kyobashi_unit_id uuid := '3577e8af-3dc7-4082-959b-b2d43331c68c';
  v_fukuoka_term public.lease_contract_unit_term%rowtype;
  v_kyobashi_old public.lease_contract_unit_term%rowtype;
  v_kyobashi_new public.lease_contract_unit_term%rowtype;
begin
  -- 三共福岡ビル 3F EF: 2026-07-01 applicable rent was corrected to 469,248.
  select * into v_fukuoka_term
  from public.lease_contract_unit_term
  where lease_contract_unit_id = v_fukuoka_unit_id
    and effective_from = date '2026-07-01'
  for update;

  if not found then
    raise exception 'Expected Fukuoka 3F EF rent term was not found';
  elsif v_fukuoka_term.monthly_rent_amount = 120320 then
    update public.lease_contract_unit_term
    set monthly_rent_amount = 469248, updated_at = now()
    where lease_contract_unit_term_id = v_fukuoka_term.lease_contract_unit_term_id;
  elsif v_fukuoka_term.monthly_rent_amount is distinct from 469248 then
    raise exception 'Unexpected Fukuoka 3F EF rent: %', v_fukuoka_term.monthly_rent_amount;
  end if;

  -- 三共京橋ビル 2F A / 住電商事: close the previous split rent and start
  -- the corrected 1,222,236 rent from 2026-10-01.
  select term.* into v_kyobashi_old
  from public.lease_contract_unit_term term
  where term.lease_contract_unit_id = v_kyobashi_unit_id
    and term.effective_from = date '2005-04-15'
  for update;

  select term.* into v_kyobashi_new
  from public.lease_contract_unit_term term
  where term.lease_contract_unit_id = v_kyobashi_unit_id
    and term.effective_from = date '2026-10-01'
  for update;

  if found and v_kyobashi_new.effective_to is null
      and v_kyobashi_new.monthly_rent_amount = 1222236
      and v_kyobashi_new.monthly_common_charge_amount = 0
      and v_kyobashi_old.effective_to = date '2026-09-30' then
    null; -- Already corrected in the linked database.
  elsif v_kyobashi_old.lease_contract_unit_term_id is not null
      and v_kyobashi_old.effective_to is null
      and v_kyobashi_old.monthly_rent_amount = 769556
      and v_kyobashi_old.monthly_common_charge_amount = 328193
      and v_kyobashi_new.lease_contract_unit_term_id is null then
    update public.lease_contract_unit_term
    set effective_to = date '2026-09-30', updated_at = now()
    where lease_contract_unit_term_id = v_kyobashi_old.lease_contract_unit_term_id;

    insert into public.lease_contract_unit_term (
      lease_contract_unit_id, lease_contract_amendment_id, effective_from,
      effective_to, monthly_rent_amount, monthly_common_charge_amount,
      deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount
    ) values (
      v_kyobashi_unit_id, null, date '2026-10-01', null, 1222236, 0,
      v_kyobashi_old.deposit_amount, v_kyobashi_old.security_deposit_amount,
      v_kyobashi_old.key_money_amount, v_kyobashi_old.renewal_fee_amount
    );

    update public.lease_contract_unit
    set monthly_rent_amount = 1222236,
        monthly_common_charge_amount = 0,
        updated_at = now()
    where lease_contract_unit_id = v_kyobashi_unit_id;
  else
    raise exception 'Unexpected Kyobashi 2F A rent-term state; refusing correction';
  end if;
end;
$$;
