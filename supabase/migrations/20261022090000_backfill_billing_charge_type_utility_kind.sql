update public.billing_charge_type
set utility_kind = case charge_type_name
  when '電気代' then 'electricity'
  when '水道代' then 'water'
  when 'ガス代' then 'gas'
  else utility_kind
end,
updated_at = now()
where utility_kind is null
  and charge_type_name in ('電気代', '水道代', 'ガス代');
