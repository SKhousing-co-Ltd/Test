begin;

do $$
begin
  if public.normalize_contract_approval_floor('２階') <> '2F' then
    raise exception '全角数字の階表記を正規化できていません';
  end if;
  if public.normalize_contract_approval_floor('b1f') <> 'B1F' then
    raise exception '地下階の英字表記を正規化できていません';
  end if;
  if public.normalize_contract_approval_floor('地下３階') <> 'B3F' then
    raise exception '地下階の日本語表記を正規化できていません';
  end if;
  if public.appsuite_contract_floor('{"階数":{"val":"7F"}}'::jsonb) <> '7F' then
    raise exception 'AppSuiteオブジェクト形式の階情報を取得できていません';
  end if;
  if public.appsuite_contract_floor('{"floor_label":"10F"}'::jsonb) <> '10F' then
    raise exception 'AppSuite文字列形式の階情報を取得できていません';
  end if;
  if public.appsuite_contract_property('{"ビル名称":{"val":"三共四ツ橋ビル"}}'::jsonb) <> '三共四ツ橋ビル' then raise exception 'AppSuite原文のビル名称を取得できていません'; end if;
  if public.appsuite_contract_unit_label('{"号室":{"val":"501"}}'::jsonb) <> '501' then raise exception 'AppSuite原文の区画を取得できていません'; end if;
  if public.appsuite_contract_space_type('{"契約区分":{"val":"駐車場"}}'::jsonb) <> '駐車場' then raise exception 'AppSuite原文の区分を取得できていません'; end if;
  if not public.contract_property_names_match('三共郡山ビル南館', '三共ビル郡山南館') then raise exception '郡山南館の表記揺れを照合できていません'; end if;
  if not public.contract_property_names_match('三共郡山ビル北館', '三共ビル郡山北館') then raise exception '郡山北館の表記揺れを照合できていません'; end if;
  if public.contract_property_names_match('三共郡山ビル南館', '三共郡山ビル北館') then raise exception '郡山南館と北館を同一物件として扱ってはいけません'; end if;
end $$;

select '1..1';
select 'ok 1 - contract approval floor normalization assertions completed';

rollback;
