begin;

do $$
begin
  if public.normalize_rent_roll_tenant_code('―') is not null
     or public.normalize_rent_roll_tenant_code('—') is not null
     or public.normalize_rent_roll_tenant_code('-') is not null
     or public.normalize_rent_roll_tenant_code('　 ') is not null then
    raise exception 'placeholder tenant codes must be treated as unset';
  end if;
  if public.normalize_rent_roll_tenant_code(' 1311 ') <> '1311' then
    raise exception 'valid tenant codes must remain usable';
  end if;
  if to_regprocedure('public.apply_rent_roll_contract_edit_with_terms_and_identity(uuid,integer,integer,jsonb,jsonb,jsonb,uuid,text,integer,text,date)') is null then
    raise exception 'identity-aware rent-roll edit RPC does not exist';
  end if;
  if position('unit_row_version' in pg_get_functiondef('public.contract_term_detail_for_audit(uuid,date)'::regprocedure)) = 0 then
    raise exception 'contract detail must expose the unit row version';
  end if;
  if position('名称一致で照合' in pg_get_functiondef('private.match_rent_roll_import_batch(uuid)'::regprocedure)) = 0 then
    raise exception 'code-less reconciliation must document name matching';
  end if;
end;
$$;

rollback;
