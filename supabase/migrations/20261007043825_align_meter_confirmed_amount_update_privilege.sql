-- Confirmed meter amounts are immutable after insertion.
revoke update on public.meter_reading_confirmed_amount from anon, authenticated;
