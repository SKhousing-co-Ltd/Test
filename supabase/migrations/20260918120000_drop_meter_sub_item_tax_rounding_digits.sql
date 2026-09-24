-- 税抜換算は金額を出す処理で、小数点以下しか発生しません。
-- 桁数を選べる形はやめ、丸め方だけを持たせます。
alter table public.asset_meter_sub_item drop column if exists tax_rounding_digits;
