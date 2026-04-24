import type { ZoneDefinition } from "@/schemas";

export function pointInRectangle(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  return px >= x && py >= y && px <= x + w && py <= y + h;
}

export function pointInPolygon(px: number, py: number, points: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i]!.x;
    const yi = points[i]!.y;
    const xj = points[j]!.x;
    const yj = points[j]!.y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInZone(px: number, py: number, zone: ZoneDefinition): boolean {
  const g = zone.geometry;
  if (g.type === "rectangle") {
    return pointInRectangle(px, py, g.x, g.y, g.width, g.height);
  }
  return pointInPolygon(px, py, g.points);
}

export function objectCenter(o: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: o.x + o.w / 2, y: o.y + o.h / 2 };
}

/** Returns true only when every corner of the bounding box lies inside the zone. */
export function allCornersInZone(
  o: { x: number; y: number; w: number; h: number },
  zone: ZoneDefinition,
): boolean {
  const corners: [number, number][] = [
    [o.x,        o.y],
    [o.x + o.w,  o.y],
    [o.x,        o.y + o.h],
    [o.x + o.w,  o.y + o.h],
  ];
  return corners.every(([px, py]) => pointInZone(px, py, zone));
}
