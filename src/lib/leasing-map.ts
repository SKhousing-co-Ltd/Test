export type Point = [number, number];
export type GeoJSONMultiPolygon = { type: 'MultiPolygon'; coordinates: Point[][][] };

export function toMultiPolygon(points: Point[]): GeoJSONMultiPolygon {
  const last = points[points.length - 1];
  const ring = points.length && (points[0][0] !== last?.[0] || points[0][1] !== last?.[1]) ? [...points, points[0]] : points;
  return { type: 'MultiPolygon', coordinates: [[ring]] };
}

export function pathFor(geometry: GeoJSONMultiPolygon) {
  return geometry.coordinates.flatMap((polygon) => polygon.map((ring) => `M ${ring.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`)).join(' ');
}

export function centerFor(geometry: GeoJSONMultiPolygon): Point {
  const points = geometry.coordinates[0]?.[0] ?? [[.5, .5]];
  const unique = points.slice(0, -1);
  return [unique.reduce((sum, point) => sum + point[0], 0) / unique.length, unique.reduce((sum, point) => sum + point[1], 0) / unique.length];
}

export function fileKind(file: File): 'png' | 'jpeg' | 'svg' | 'pdf' | null {
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type === 'image/svg+xml') return 'svg';
  if (file.type === 'image/png') return 'png';
  if (file.type === 'image/jpeg') return 'jpeg';
  return null;
}

export function scopeKey(plan: { propertyId: string; floorLabel: string }) {
  return `${plan.propertyId}|${plan.floorLabel}`;
}
