import { allProductCategories, type ProductCategory } from '../lib/product-categories.ts';

export function restoreRentRollCategories(value: unknown, legacy: boolean): ProductCategory[] {
  if (!Array.isArray(value)) return allProductCategories;
  const selected = new Set(value);
  if (legacy && selected.has('parking')) selected.add('bicycle_parking');
  return allProductCategories.filter((category) => selected.has(category));
}

export function matchesRentRollUnitType(category: ProductCategory, filter: 'all' | 'space' | 'parking' | 'bicycle_parking'): boolean {
  if (filter === 'all') return true;
  if (filter === 'space') return category !== 'parking' && category !== 'bicycle_parking';
  return category === filter;
}
