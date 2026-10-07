grant insert, update on public.property_acquisition_plan, public.property_acquisition_plan_year to authenticated;
create policy "authenticated users can insert acquisition plans" on public.property_acquisition_plan for insert to authenticated with check (true);
create policy "authenticated users can update acquisition plans" on public.property_acquisition_plan for update to authenticated using (true) with check (true);
create policy "authenticated users can insert acquisition plan years" on public.property_acquisition_plan_year for insert to authenticated with check (true);
create policy "authenticated users can update acquisition plan years" on public.property_acquisition_plan_year for update to authenticated using (true) with check (true);
create policy "authenticated users can delete acquisition plan years" on public.property_acquisition_plan_year for delete to authenticated using (true);
