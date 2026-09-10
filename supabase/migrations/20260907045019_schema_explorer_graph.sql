-- 管理者向けスキーマ探索。業務データや auth スキーマの実体は返さない。
create or replace function public.get_schema_explorer_graph()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  if auth.uid() is null
     or not public.current_account_is_active()
     or not public.current_account_is_admin() then
    raise exception 'スキーマ探索を実行する権限がありません';
  end if;

  with public_tables as (
    select class.oid, namespace.nspname as table_schema, class.relname as table_name,
           pg_catalog.obj_description(class.oid, 'pg_class') as comment
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p')
  ),
  table_nodes as (
    select jsonb_build_object(
      'id', table_schema || '.' || table_name,
      'schema', table_schema,
      'name', table_name,
      'external', false,
      'comment', comment,
      'columns', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', attribute.attname,
          'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
          'nullable', not attribute.attnotnull,
          'default', pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid),
          'comment', pg_catalog.col_description(attribute.attrelid, attribute.attnum)
        ) order by attribute.attnum)
        from pg_catalog.pg_attribute attribute
        left join pg_catalog.pg_attrdef default_value
          on default_value.adrelid = attribute.attrelid and default_value.adnum = attribute.attnum
        where attribute.attrelid = public_tables.oid
          and attribute.attnum > 0 and not attribute.attisdropped
      ), '[]'::jsonb),
      'primary_key', coalesce((
        select jsonb_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.pg_constraint key_constraint
        join unnest(key_constraint.conkey) with ordinality as key_column(attnum, ordinality) on true
        join pg_catalog.pg_attribute attribute on attribute.attrelid = key_constraint.conrelid and attribute.attnum = key_column.attnum
        where key_constraint.conrelid = public_tables.oid and key_constraint.contype = 'p'
      ), '[]'::jsonb),
      'unique_constraints', coalesce((
        select jsonb_agg(jsonb_build_object('name', unique_constraint.conname, 'columns', constraint_columns.columns) order by unique_constraint.conname)
        from pg_catalog.pg_constraint unique_constraint
        cross join lateral (
          select jsonb_agg(attribute.attname order by key_column.ordinality) as columns
          from unnest(unique_constraint.conkey) with ordinality as key_column(attnum, ordinality)
          join pg_catalog.pg_attribute attribute on attribute.attrelid = unique_constraint.conrelid and attribute.attnum = key_column.attnum
        ) constraint_columns
        where unique_constraint.conrelid = public_tables.oid and unique_constraint.contype = 'u'
      ), '[]'::jsonb)
    ) as node
    from public_tables
  ),
  foreign_keys as (
    select jsonb_build_object(
      'id', 'fk:' || fk_constraint.oid::text,
      'name', fk_constraint.conname,
      'source', source_namespace.nspname || '.' || source_class.relname,
      'target', target_namespace.nspname || '.' || target_class.relname,
      'source_columns', source_columns.columns,
      'target_columns', target_columns.columns,
      'on_update', case fk_constraint.confupdtype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE' when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end,
      'on_delete', case fk_constraint.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE' when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end
    ) as edge,
    target_namespace.nspname || '.' || target_class.relname as target_id
    from pg_catalog.pg_constraint fk_constraint
    join pg_catalog.pg_class source_class on source_class.oid = fk_constraint.conrelid
    join pg_catalog.pg_namespace source_namespace on source_namespace.oid = source_class.relnamespace
    join pg_catalog.pg_class target_class on target_class.oid = fk_constraint.confrelid
    join pg_catalog.pg_namespace target_namespace on target_namespace.oid = target_class.relnamespace
    cross join lateral (
      select jsonb_agg(attribute.attname order by key_column.ordinality) as columns
      from unnest(fk_constraint.conkey) with ordinality as key_column(attnum, ordinality)
      join pg_catalog.pg_attribute attribute on attribute.attrelid = fk_constraint.conrelid and attribute.attnum = key_column.attnum
    ) source_columns
    cross join lateral (
      select jsonb_agg(attribute.attname order by key_column.ordinality) as columns
      from unnest(fk_constraint.confkey) with ordinality as key_column(attnum, ordinality)
      join pg_catalog.pg_attribute attribute on attribute.attrelid = fk_constraint.confrelid and attribute.attnum = key_column.attnum
    ) target_columns
    where fk_constraint.contype = 'f'
      and source_namespace.nspname = 'public'
      and (target_namespace.nspname = 'public' or (target_namespace.nspname = 'auth' and target_class.relname = 'users'))
  ),
  external_nodes as (
    select jsonb_build_object('id', 'auth.users', 'schema', 'auth', 'name', 'users', 'external', true, 'comment', null, 'columns', '[]'::jsonb, 'primary_key', '[]'::jsonb, 'unique_constraints', '[]'::jsonb) as node
    where exists (select 1 from foreign_keys where target_id = 'auth.users')
  )
  select jsonb_build_object(
    'tables', coalesce((select jsonb_agg(node order by node->>'id') from (select node from table_nodes union all select node from external_nodes) nodes), '[]'::jsonb),
    'relationships', coalesce((select jsonb_agg(edge order by edge->>'id') from foreign_keys), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_schema_explorer_graph() from public, anon;
grant execute on function public.get_schema_explorer_graph() to authenticated;
