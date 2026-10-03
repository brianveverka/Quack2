// SPDX-License-Identifier: GPL-2.0-or-later
// Shared simulation constants. Coordinates are float world units throughout.

export type Vec3 = readonly [number, number, number];

/**
 * Standing player bounding box relative to the origin: 32x32 wide, 56 tall, origin
 * 24 units above the feet. Matches stock Quake 2 pmove; defined only here.
 */
export const PLAYER_MINS: Vec3 = Object.freeze([-16, -16, -24] as const);
export const PLAYER_MAXS: Vec3 = Object.freeze([16, 16, 32] as const);
