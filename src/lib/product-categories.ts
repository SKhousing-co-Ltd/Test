export const productCategories = [
  { code: 'office', label: '事務所' },
  { code: 'residential', label: '住居' },
  { code: 'parking', label: '駐車場' },
  { code: 'bicycle_parking', label: '駐輪場' },
  { code: 'signage', label: '看板' },
  { code: 'warehouse', label: '倉庫' },
  { code: 'antenna', label: 'アンテナ' },
  { code: 'other', label: 'その他' },
] as const;

export type ProductCategory = typeof productCategories[number]['code'];

export const allProductCategories = productCategories.map(({ code }) => code) as ProductCategory[];
export const productCategoryLabel = Object.fromEntries(
  productCategories.map(({ code, label }) => [code, label]),
) as Record<ProductCategory, string>;

const productCategorySet = new Set<ProductCategory>(allProductCategories);

export function normalizeProductCategory(value: string | null | undefined): ProductCategory {
  if (value === 'storage') return 'warehouse';
  if (value === 'equipment' || value === 'retail') return 'other';
  return productCategorySet.has(value as ProductCategory) ? value as ProductCategory : 'other';
}
