// テナント並び順の決め方を確かめます。
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveBefore, orderTenants, tenantComparator } from './tenantOrder.ts';

test('ドラッグした行を、挿入線の位置へ移す', () => {
  const items = ['A', 'B', 'C', 'D'];
  assert.deepEqual(moveBefore(items, 0, 2), ['B', 'A', 'C', 'D']);
  assert.deepEqual(moveBefore(items, 3, 1), ['A', 'D', 'B', 'C']);
  assert.deepEqual(moveBefore(items, 1, 4), ['A', 'C', 'D', 'B']);
  assert.deepEqual(moveBefore(items, 2, 0), ['C', 'A', 'B', 'D']);
  // 自分の上下に落としても並びは変わりません。
  assert.deepEqual(moveBefore(items, 1, 1), items);
  assert.deepEqual(moveBefore(items, 1, 2), items);
});

// レントロールの並び（階順）です。B と C は同じ区画 u2 を契約しています。
const rows = [
  { tenant_id: 'A', unit_id: 'u1' },
  { tenant_id: 'B', unit_id: 'u2' },
  { tenant_id: 'C', unit_id: 'u2' },
  { tenant_id: 'D', unit_id: 'u3' },
  { tenant_id: 'E', unit_id: 'u4' },
  { tenant_id: null, unit_id: 'u5' },
];

test('並び順が未保存なら、レントロールの階順のまま', () => {
  assert.deepEqual(orderTenants(rows, []), ['A', 'B', 'C', 'D', 'E']);
});

test('保存した並び順を優先する', () => {
  const saved = ['E', 'D', 'C', 'B', 'A'].map((tenant_id, sort_order) => ({ tenant_id, sort_order }));
  assert.deepEqual(orderTenants(rows, saved), ['E', 'D', 'C', 'B', 'A']);
});

test('未保存のテナントは、階順で前後のテナントの間に差し込む', () => {
  const saved = [{ tenant_id: 'A', sort_order: 0 }, { tenant_id: 'E', sort_order: 1 }];
  const onlyD = rows.filter((row) => row.tenant_id !== 'B' && row.tenant_id !== 'C');
  assert.deepEqual(orderTenants(onlyD, saved), ['A', 'D', 'E']);
});

test('同じ区画に入居しているテナントは、並び順が決まっているテナントのすぐ下に置く', () => {
  // B を末尾に並べ替えてあっても、同じ区画の C は B のすぐ下に来ます。
  const saved = ['A', 'D', 'E', 'B'].map((tenant_id, sort_order) => ({ tenant_id, sort_order }));
  assert.deepEqual(orderTenants(rows, saved), ['A', 'D', 'E', 'B', 'C']);
});

test('同じ区画のテナントが複数あれば、階順のまま続けて置く', () => {
  const shared = [...rows, { tenant_id: 'F', unit_id: 'u2' }];
  const saved = ['B', 'A', 'D', 'E'].map((tenant_id, sort_order) => ({ tenant_id, sort_order }));
  assert.deepEqual(orderTenants(shared, saved), ['B', 'C', 'F', 'A', 'D', 'E']);
});

test('退去したテナントの保存行は無視する', () => {
  const saved = ['Z', 'E', 'A'].map((tenant_id, sort_order) => ({ tenant_id, sort_order }));
  assert.deepEqual(orderTenants(rows.filter((row) => row.tenant_id === 'A' || row.tenant_id === 'E'), saved), ['E', 'A']);
});

test('階順は文字列ではなく、地下→低層→高層の順にする', () => {
  // RPC は階を文字列で並べるため、10F が 2F より前、B1F が 9F より後ろで届きます。
  const fromRpc = [
    { tenant_id: 'ten', unit_id: 'u10', floor_label: '10F', unit_code: '1001' },
    { tenant_id: 'two', unit_id: 'u2', floor_label: '2F', unit_code: '201' },
    { tenant_id: 'nine', unit_id: 'u9', floor_label: '9F', unit_code: '901' },
    { tenant_id: 'base', unit_id: 'ub', floor_label: 'B1F', unit_code: 'B101' },
  ];
  assert.deepEqual(orderTenants(fromRpc, []), ['base', 'two', 'nine', 'ten']);
  // 未保存のテナントも、この階順で「自分より上の階のテナントの手前」に差し込みます。
  assert.deepEqual(orderTenants(fromRpc, [{ tenant_id: 'ten', sort_order: 0 }, { tenant_id: 'two', sort_order: 1 }]), ['base', 'nine', 'ten', 'two']);
});

test('並び順に居ないテナントは後ろに回し、元の順番を保つ', () => {
  const compare = tenantComparator(['B', 'A']);
  const items = [{ id: 'x', tenant: null }, { id: 'a', tenant: 'A' }, { id: 'y', tenant: 'Q' }, { id: 'b', tenant: 'B' }];
  assert.deepEqual([...items].sort((left, right) => compare(left.tenant, right.tenant)).map((item) => item.id), ['b', 'a', 'x', 'y']);
});
