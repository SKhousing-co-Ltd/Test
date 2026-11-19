import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { matchesRentRollUnitType, restoreRentRollCategories } from './rentRollCategories.ts';

test('従来の駐車場選択は駐輪場の表示も引き継ぐ', () => {
  assert.deepEqual(restoreRentRollCategories(['office', 'parking'], true), ['office', 'parking', 'bicycle_parking']);
  assert.deepEqual(restoreRentRollCategories(['office'], true), ['office']);
});
test('新しい選択は駐車場と駐輪場を独立して復元する', () => {
  assert.deepEqual(restoreRentRollCategories(['parking'], false), ['parking']);
  assert.deepEqual(restoreRentRollCategories(['bicycle_parking'], false), ['bicycle_parking']);
});
test('区画種別の絞り込みは駐車場と駐輪場を別扱いにする', () => {
  assert.equal(matchesRentRollUnitType('bicycle_parking', 'parking'), false);
  assert.equal(matchesRentRollUnitType('bicycle_parking', 'bicycle_parking'), true);
  assert.equal(matchesRentRollUnitType('bicycle_parking', 'space'), false);
  assert.equal(matchesRentRollUnitType('parking', 'space'), false);
  assert.equal(matchesRentRollUnitType('office', 'space'), true);
});
