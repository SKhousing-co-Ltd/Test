begin;

do $$
begin
  if to_regclass('public.clients_table') is null then
    raise exception 'clients_table does not exist';
  end if;

  if to_regclass('public.client_subcategories_master') is null then
    raise exception 'client_subcategories_master does not exist';
  end if;

  if (select count(*) from public.client_subcategories_master) <> 5 then
    raise exception 'Expected five client subcategories';
  end if;

  if (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'clients_table'
      and column_name in (
        'client_code',
        'client_subcategory_id',
        'contact_person_name',
        'contact_email',
        'contact_phone',
        'contact_department',
        'contact_position'
      )
  ) <> 7 then
    raise exception 'Expected client contact columns are missing';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conname = 'fk_clients_table_category_subcategory'
      and constraint_record.contype = 'f'
      and constraint_record.conrelid = 'public.clients_table'::regclass
      and constraint_record.confrelid = 'public.client_subcategories_master'::regclass
  ) then
    raise exception 'clients_table category/subcategory foreign key is missing';
  end if;

  if not exists (
    select 1
    from public.clients_table client
    join public.client_subcategories_master subcategory
      on subcategory.client_subcategory_id = client.client_subcategory_id
     and subcategory.client_categories_id = client.client_categories_id
    where client.company_name = '株式会社サンプルA'
      and subcategory.subcategory_code = 'customer_tenant'
  ) then
    raise exception '株式会社サンプルA is not classified as テナント';
  end if;

  if not exists (
    select 1
    from public.clients_table client
    join public.client_subcategories_master subcategory
      on subcategory.client_subcategory_id = client.client_subcategory_id
     and subcategory.client_categories_id = client.client_categories_id
    where client.company_name = '有限会社サンプルB'
      and subcategory.subcategory_code = 'supplier_broker'
  ) then
    raise exception '有限会社サンプルB is not classified as 仲介業者';
  end if;

  if exists (
    select 1
    from public.clients_table
    where client_categories_id is null
       or client_subcategory_id is null
  ) then
    raise exception 'A client is missing its category or subcategory';
  end if;
end $$;

rollback;
