-- Configurable contract-document templates, layouts, and archived type changes.
create table public.contract_document_template (
  contract_document_template_id uuid primary key default gen_random_uuid(),
  document_type varchar(50) not null unique,
  display_name varchar(100) not null,
  requires_plan boolean not null default false,
  active_revision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_contract_document_template_type check (document_type in ('ordinary_lease','fixed_term_building_lease','parking','bicycle_parking','warehouse'))
);

create table public.contract_document_template_revision (
  contract_document_template_revision_id uuid primary key default gen_random_uuid(),
  contract_document_template_id uuid not null references public.contract_document_template(contract_document_template_id) on delete cascade,
  revision_no integer not null,
  status varchar(20) not null default 'draft' check (status in ('draft','published','archived')),
  template_file_path text,
  font_file_path text,
  field_definitions jsonb not null default '[]'::jsonb,
  layout_definition jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_document_template_id, revision_no),
  constraint ck_template_revision_fields check (jsonb_typeof(field_definitions) = 'array'),
  constraint ck_template_revision_layout check (jsonb_typeof(layout_definition) = 'object')
);

alter table public.contract_document_template
  add constraint fk_contract_document_template_active_revision
  foreign key (active_revision_id) references public.contract_document_template_revision(contract_document_template_revision_id) on delete set null;

alter table public.lease_contract_document
  drop constraint if exists ck_lease_contract_document_type,
  add constraint ck_lease_contract_document_type check (document_type in ('ordinary_lease','fixed_term_building_lease','parking','bicycle_parking','warehouse')),
  add column if not exists contract_document_template_revision_id uuid references public.contract_document_template_revision(contract_document_template_revision_id);

create table public.lease_contract_document_history (
  lease_contract_document_history_id uuid primary key default gen_random_uuid(),
  lease_contract_id uuid not null references public.lease_contract(lease_contract_id) on delete cascade,
  document_type varchar(50) not null,
  archived_document jsonb not null,
  archived_at timestamptz not null default now(),
  archived_by uuid references auth.users(id),
  constraint ck_lease_contract_document_history_data check (jsonb_typeof(archived_document) = 'object')
);

insert into public.contract_document_template(document_type, display_name, requires_plan)
values
  ('ordinary_lease', '普通賃貸借', true),
  ('fixed_term_building_lease', '定期建物賃貸借', true),
  ('parking', '駐車場', false),
  ('bicycle_parking', '駐輪場', false),
  ('warehouse', '倉庫', true)
on conflict (document_type) do nothing;

-- The current ordinary-lease template is seeded as the first configurable published revision.
with template_row as (
  select contract_document_template_id from public.contract_document_template where document_type = 'ordinary_lease'
), inserted as (
  insert into public.contract_document_template_revision(contract_document_template_id, revision_no, status, template_file_path, font_file_path, field_definitions, layout_definition, published_at)
  select contract_document_template_id, 1, 'published',
    'templates/ordinary_lease/loan-room-lease-2025-06-02-source-refresh-2026-07-29.pdf',
    'templates/ordinary_lease/yumin.ttf',
    '[{"key":"propertyName","label":"物件名","type":"text","required":true},{"key":"propertyAddress","label":"所在地","type":"text"},{"key":"propertyLotAddress","label":"地番","type":"text"},{"key":"buildingStructure","label":"構造","type":"text"},{"key":"buildingGrossAreaSqm","label":"延床面積","type":"number"},{"key":"unitNames","label":"貸室・区画","type":"text"},{"key":"floorLabel","label":"階数","type":"integer"},{"key":"leasedAreaSqm","label":"賃貸面積","type":"number","required":true},{"key":"tenantName","label":"賃借人","type":"text","required":true},{"key":"guarantorName","label":"連帯保証人","type":"text"},{"key":"guarantorLimitAmount","label":"保証限度額","type":"number"},{"key":"usePurpose","label":"使用目的","type":"text"},{"key":"contractStartDate","label":"契約開始日","type":"date","required":true},{"key":"contractEndDate","label":"契約終了日","type":"date","required":true},{"key":"monthlyRentAmount","label":"月額賃料","type":"number"},{"key":"rentPaymentDue","label":"賃料支払期限","type":"text"},{"key":"dailyCalculationMethod","label":"日割計算","type":"text"},{"key":"depositAmount","label":"敷金","type":"number"},{"key":"depositMonths","label":"敷金月数","type":"number"},{"key":"monthlyCommonChargeAmount","label":"月額共益費","type":"number"},{"key":"securityDepositAmount","label":"保証金","type":"number"},{"key":"keyMoneyAmount","label":"礼金","type":"number"},{"key":"specialProvisions","label":"特約事項","type":"textarea"},{"key":"tenantSignerName","label":"賃借人署名者名","type":"text"},{"key":"brokerName","label":"仲介業者名","type":"text"}]'::jsonb,
    '{"placements":[{"page":1,"key":"tenantName","x":261,"y":199,"fontSize":12,"maxWidth":220,"clear":{"x":250,"y":185,"width":250,"height":26}},{"page":2,"key":"tenantName","x":208,"y":592,"fontSize":10,"maxWidth":175,"clear":{"x":205,"y":582,"width":285,"height":20}},{"page":2,"key":"propertyName","x":208,"y":540,"fontSize":10,"maxWidth":175,"clear":{"x":205,"y":530,"width":285,"height":20}},{"page":2,"key":"propertyAddress","x":208,"y":488,"fontSize":9,"maxWidth":175,"clear":{"x":205,"y":478,"width":285,"height":20}},{"page":2,"key":"contractStartDate","x":208,"y":358,"fontSize":8.6,"maxWidth":120,"format":"date","clear":{"x":205,"y":350,"width":140,"height":22}},{"page":2,"key":"contractEndDate","x":360,"y":358,"fontSize":8.6,"maxWidth":120,"format":"date","clear":{"x":350,"y":350,"width":140,"height":22}},{"page":2,"key":"monthlyRentAmount","x":238,"y":315,"fontSize":10,"maxWidth":80,"format":"yen","clear":{"x":205,"y":304,"width":285,"height":21}},{"page":13,"key":"tenantName","x":226,"y":530,"fontSize":10,"maxWidth":160},{"page":14,"key":"leasedAreaSqm","x":50,"y":722,"fontSize":9,"maxWidth":200,"format":"sqm","clear":{"x":45,"y":709,"width":210,"height":25}}],"plan":{"page":14,"x":47.625,"y":125,"maxWidth":500,"maxHeight":560}}'::jsonb, now() from template_row
  on conflict (contract_document_template_id, revision_no) do nothing
  returning contract_document_template_revision_id, contract_document_template_id
)
update public.contract_document_template template set active_revision_id = coalesce(template.active_revision_id, inserted.contract_document_template_revision_id)
from inserted where template.contract_document_template_id = inserted.contract_document_template_id;

update public.lease_contract_document document
set contract_document_template_revision_id = template.active_revision_id
from public.contract_document_template template
where template.document_type = 'ordinary_lease' and document.contract_document_template_revision_id is null;

create index ix_contract_document_template_revision_template on public.contract_document_template_revision(contract_document_template_id, status);
create index ix_lease_contract_document_history_contract on public.lease_contract_document_history(lease_contract_id, archived_at desc);

alter table public.contract_document_template enable row level security;
alter table public.contract_document_template_revision enable row level security;
alter table public.lease_contract_document_history enable row level security;
grant select, insert, update on public.contract_document_template to authenticated;
grant select, insert, update on public.contract_document_template_revision to authenticated;
grant select, insert on public.lease_contract_document_history to authenticated;
create policy "active users manage contract document templates" on public.contract_document_template for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage contract document template revisions" on public.contract_document_template_revision for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users read contract document history" on public.lease_contract_document_history for select to authenticated using (public.current_account_is_active());
create policy "active users create contract document history" on public.lease_contract_document_history for insert to authenticated with check (public.current_account_is_active());
